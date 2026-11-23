import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedDevelopmentData } from "../../scripts/development-seed";
import { migrateDatabase } from "../../scripts/lib/database-management";
import { recordAuditLog } from "../../src/api/audit-log";
import { commitMutation } from "../../src/api/mutation";
import {
  notificationEventKey, recordNotification, recordReviewRequestNotifications,
} from "../../src/api/notifications";
import { canEnterAdmin, loadAccessState } from "../../src/auth/access";
import * as auth from "../../src/db/auth-schema";
import * as content from "../../src/db/content-schema";
import * as moderation from "../../src/db/moderation-schema";
import * as community from "../../src/db/schema";
import { endPool, isolatedDatabase } from "./isolated-database";

/**
 * 通知・監査ログの記録処理（#47 ①②）。
 * AC-01：呼び出し元と同じトランザクションで保存され、ロールバックすると何も残らない。
 * AC-02：再送しても通知が重複しない。自己通知が作られない。
 * AC-03：通知・監査ログに、対象の本文・許可外の項目が含まれない。
 */

vi.mock("server-only", () => ({}));

const { noticeRequests, qaQuestions, qaResponses } = content;
const { auditLogs, notifications, operationReceipts } = moderation;
const { communityUsers } = community;
const schema = { ...auth, ...content, ...community, ...moderation };

let target: Awaited<ReturnType<typeof isolatedDatabase>>;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
const ids = new Map<string, string>();
const id = (username: string) => {
  const value = ids.get(username);
  if (!value) throw new Error(`Missing seed account: ${username}`);
  return value;
};

beforeAll(async () => {
  target = await isolatedDatabase();
  await migrateDatabase(target.client);
  pool = new Pool({ connectionString: target.url.toString(), max: 5 });
  db = drizzle(pool, { schema });
  const credentialsDir = await mkdtemp(join(tmpdir(), "team-b-records-test-"));
  try {
    await seedDevelopmentData(drizzle(target.client), credentialsDir);
  } finally {
    await rm(credentialsDir, { recursive: true, force: true });
  }
  const rows = await db.select({ id: auth.user.id, username: auth.user.username }).from(auth.user);
  for (const { id: userId, username } of rows) if (username) ids.set(username, userId);
});

afterAll(async () => {
  await endPool(pool);
  await target?.dispose();
});

beforeEach(async () => {
  // 各テストの前に、seed の利用状態へ戻す。
  await db.update(communityUsers).set({ profileState: "public", accountStatus: "active" })
    .where(inArray(communityUsers.userId, ["poc_a001", "poc_a_mgr", "poc_staff_mgr"].map(id)));
});

/** プロフィール非表示と同じ形の更新を、共通の更新処理で実行する。 */
function hideProfile(key: string, targetUser: string, options: { fail?: boolean } = {}) {
  const actorId = id("poc_school");
  return commitMutation(db, {
    actorId,
    request: { method: "POST", path: `/api/v1/admin/users/${targetUser}/profile-hiding`, requestKey: key },
    body: { publicReason: "連絡先が掲載されているため" },
    resolveUserIds: async () => [targetUser],
    authorizeEntry: async () => {},
    authorizeReplay: async () => {},
    async execute({ tx, now }) {
      await tx.update(communityUsers).set({ profileState: "hidden" }).where(eq(communityUsers.userId, targetUser));
      const auditLogId = await recordAuditLog(tx, {
        action: "profile.hidden", actorId, targetId: targetUser,
        before: { profileState: "public" }, after: { profileState: "hidden" },
        publicReason: "連絡先が掲載されているため", at: now,
      });
      await recordNotification(tx, {
        recipientId: targetUser, actorId,
        subject: { kind: "profile_hidden", userId: targetUser, auditLogId, publicReason: "連絡先が掲載されているため" },
        at: now,
      });
      if (options.fail) throw new Error("fixture failure");
      return { status: 200, resource: { type: "user", id: targetUser }, version: null, state: "hidden" };
    },
  });
}

async function recordsFor(userId: string) {
  const [notices, audits] = await Promise.all([
    db.select().from(notifications).where(and(eq(notifications.recipientId, userId), eq(notifications.kind, "profile_hidden"))),
    db.select().from(auditLogs).where(and(eq(auditLogs.targetId, userId), eq(auditLogs.actionType, "profile.hidden"))),
  ]);
  return { notices, audits };
}

describe("AC-01 同じトランザクションでの記録", () => {
  it("業務更新が失敗すると、通知・監査ログ・業務更新のどれも残らない", async () => {
    const user = id("poc_a001");
    await expect(hideProfile(`rollback-${randomUUID()}`, user, { fail: true })).rejects.toThrow("fixture failure");
    const { notices, audits } = await recordsFor(user);
    expect(notices).toHaveLength(0);
    expect(audits).toHaveLength(0);
    const [state] = await db.select({ profileState: communityUsers.profileState }).from(communityUsers)
      .where(eq(communityUsers.userId, user));
    expect(state.profileState).toBe("public");
  });

  it("確定すると、通知・監査ログ・操作記録が同じ時刻で保存され、通知の契機に監査ログのIDを使う", async () => {
    const user = id("poc_a001");
    const key = `commit-${randomUUID()}`;
    const result = await hideProfile(key, user);
    const { notices, audits } = await recordsFor(user);
    expect(notices).toHaveLength(1);
    expect(audits).toHaveLength(1);
    const [receipt] = await db.select().from(operationReceipts).where(eq(operationReceipts.requestKey, key));
    expect(notices[0].createdAt.toISOString()).toBe(result.data.committedAt);
    expect(audits[0].createdAt.toISOString()).toBe(receipt.createdAt.toISOString());
    expect(notices[0].eventKey).toBe(`profile_hidden:${user}:${audits[0].id}`);
    expect(notices[0].profileUserId).toBe(user);
    expect(notices[0].publicMessage).toBe("プロフィールが管理者により非表示になりました。\n理由：連絡先が掲載されているため");
    expect(audits[0]).toMatchObject({
      actorId: id("poc_school"), systemAction: false, targetType: "user",
      beforeState: { profileState: "public" }, afterState: { profileState: "hidden" },
      publicReason: "連絡先が掲載されているため",
    });
  });
});

describe("AC-02 再送・自己通知", () => {
  it("同じ再送キーの再送では処理を繰り返さず、通知も監査ログも増えない", async () => {
    const user = id("poc_a_mgr");
    const key = `replay-${randomUUID()}`;
    const first = await hideProfile(key, user);
    const again = await hideProfile(key, user);
    expect(again.replayed).toBe(true);
    expect(again.data).toEqual(first.data);
    const { notices, audits } = await recordsFor(user);
    expect(notices).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it("同じ受信者・同じ event_key の通知は、別のトランザクションから記録しても1件だけになる", async () => {
    const [request] = await db.select({ id: noticeRequests.id }).from(noticeRequests)
      .where(eq(noticeRequests.status, "pending"));
    const input = {
      recipientId: id("poc_staff_mgr"), actorId: id("poc_a001"),
      subject: { kind: "notice_review_requested", noticeRequestId: request.id } as const, at: new Date(),
    };
    const results = await Promise.all([1, 2].map(() => db.transaction((tx) => recordNotification(tx, input))));
    expect(results.sort()).toEqual([false, true]);
    const rows = await db.select().from(notifications).where(and(
      eq(notifications.recipientId, input.recipientId), eq(notifications.eventKey, notificationEventKey(input.subject)),
    ));
    expect(rows).toHaveLength(1);
  });

  it("受信者と実行者が同じなら通知を作らない", async () => {
    const author = id("poc_s001");
    const [answer] = await db.select({ id: qaResponses.id }).from(qaResponses).where(eq(qaResponses.kind, "answer"));
    const created = await db.transaction((tx) => recordNotification(tx, {
      recipientId: author, actorId: author, subject: { kind: "qa_comment_created", responseId: answer.id }, at: new Date(),
    }));
    expect(created).toBe(false);
    const rows = await db.select().from(notifications).where(and(
      eq(notifications.recipientId, author), eq(notifications.kind, "qa_comment_created"),
    ));
    expect(rows).toHaveLength(0);
  });

  it("非表示を繰り返した場合は、監査ログごとに別の通知になる", async () => {
    const user = id("poc_staff_mgr");
    await hideProfile(`first-${randomUUID()}`, user);
    await db.update(communityUsers).set({ profileState: "public" }).where(eq(communityUsers.userId, user));
    await hideProfile(`second-${randomUUID()}`, user);
    const { notices, audits } = await recordsFor(user);
    expect(notices).toHaveLength(2);
    expect(new Set(notices.map(({ eventKey }) => eventKey))).toEqual(
      new Set(audits.map((audit) => `profile_hidden:${user}:${audit.id}`)),
    );
  });
});

describe("審査依頼の宛先", () => {
  async function reviewRequestRecipients(applicant: string) {
    // 宛先の確認だけに使う申請。seed の申請と同じ版を参照し、承認待ちの一意制約に触れない状態で作る。
    const [source] = await db.select({ noticeId: noticeRequests.noticeId, revisionId: noticeRequests.revisionId })
      .from(noticeRequests).limit(1);
    const [request] = await db.insert(noticeRequests).values({ ...source, requestKind: "edit", status: "withdrawn" })
      .returning({ id: noticeRequests.id });
    const subject = { kind: "notice_review_requested", noticeRequestId: request.id } as const;
    const created = await db.transaction((tx) => recordReviewRequestNotifications(tx, {
      applicantId: applicant, subject, at: new Date(),
    }));
    const rows = await db.select({ recipientId: notifications.recipientId }).from(notifications)
      .where(eq(notifications.noticeRequestId, request.id));
    expect(rows).toHaveLength(created);
    return new Set(rows.map(({ recipientId }) => recipientId));
  }

  it("管理エリアに入れる現在の管理者全員に送り、申請者本人・一般利用者・制限中のアプリ管理者には送らない", async () => {
    await db.update(communityUsers).set({ profileState: "hidden" }).where(eq(communityUsers.userId, id("poc_a_mgr")));
    await db.update(communityUsers).set({ accountStatus: "suspended" }).where(eq(communityUsers.userId, id("poc_staff_mgr")));
    const applicant = id("poc_a001");
    const recipients = await reviewRequestRecipients(applicant);
    expect(recipients).toEqual(new Set([id("poc_school"), id("poc_s_mgr")]));

    // 共通認可の管理権限判定（canEnterAdmin）と同じ利用者だけが宛先になる。
    const everyone = await db.select({ userId: communityUsers.userId }).from(communityUsers);
    const admins = new Set<string>();
    for (const { userId } of everyone) {
      const state = await loadAccessState(db, userId).catch(() => null);
      if (state?.access === "active" && canEnterAdmin(state.viewer) && userId !== applicant) admins.add(userId);
    }
    expect(recipients).toEqual(admins);
  });

  it("申請者が管理者でも、本人には審査依頼を送らない", async () => {
    const recipients = await reviewRequestRecipients(id("poc_s_mgr"));
    expect(recipients.has(id("poc_s_mgr"))).toBe(false);
    expect(recipients.has(id("poc_school"))).toBe(true);
  });
});

describe("AC-03 記録内容の制限", () => {
  it("通知の本文には定型文と本人向けの理由だけを保存し、対象の題名・本文を含めない", async () => {
    const [question] = await db.select().from(qaQuestions).limit(1);
    const author = question.authorId;
    const at = new Date();
    const auditLogId = await db.transaction((tx) => recordAuditLog(tx, {
      action: "profile.hidden", actorId: null, targetId: author, at,
    }));
    await db.transaction((tx) => recordNotification(tx, {
      recipientId: author, actorId: id("poc_school"),
      subject: { kind: "qa_hidden", questionId: question.id, auditLogId, publicReason: "個人情報が含まれているため" },
      at,
    }));
    const [row] = await db.select().from(notifications).where(and(
      eq(notifications.recipientId, author), eq(notifications.kind, "qa_hidden"),
    ));
    expect(row.qaQuestionId).toBe(question.id);
    expect(row.publicMessage).toBe("投稿が管理者により非表示になりました。\n理由：個人情報が含まれているため");
    expect(row.publicMessage).not.toContain(question.title);
    expect(row.publicMessage).not.toContain(question.bodyMarkdown);
  });

  it("システム処理の監査ログは実行者なし・システム操作として記録する", async () => {
    const logId = await db.transaction((tx) => recordAuditLog(tx, {
      action: "graduation.corrected", actorId: null, targetId: id("poc_s002"),
      before: { baseRole: "student", isGraduating: true }, after: { baseRole: "alumni", isGraduating: false },
      at: new Date(),
    }));
    const [row] = await db.select().from(auditLogs).where(eq(auditLogs.id, logId));
    expect(row).toMatchObject({ actorId: null, systemAction: true, targetType: "user", publicReason: null });
  });

  it("許可されていない項目・単純な値でない項目は記録せず、例外にする", async () => {
    const targetId = id("poc_s001");
    const before = await db.select().from(auditLogs).where(eq(auditLogs.targetId, targetId));
    const cases: Array<Record<string, unknown>> = [
      { bio: "本人だけに見せる自己紹介" },
      { bodyMarkdown: "投稿本文" },
      { privateRealName: "本人確認情報" },
      { profileState: { nested: "値" } },
    ];
    for (const after of cases) {
      await expect(db.transaction((tx) => recordAuditLog(tx, {
        action: "profile.hidden", actorId: id("poc_school"), targetId, after: after as never, at: new Date(),
      }))).rejects.toThrow(/監査ログ profile\.hidden/);
    }
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.targetId, targetId));
    expect(rows).toHaveLength(before.length);
  });

  it("空の理由は記録しない", async () => {
    await expect(db.transaction((tx) => recordAuditLog(tx, {
      action: "profile.hidden", actorId: id("poc_school"), targetId: id("poc_s001"), publicReason: "  ", at: new Date(),
    }))).rejects.toThrow("監査ログの理由が空です");
  });
});

it("開発用 seed の通知は共通処理の event_key の形式で保存される", async () => {
  const rows = await db.select().from(notifications)
    .where(inArray(notifications.kind, ["qa_answer_created", "event_review_requested"]));
  const answer = rows.find(({ kind }) => kind === "qa_answer_created");
  const event = rows.find(({ kind }) => kind === "event_review_requested");
  expect(answer?.eventKey).toBe(`qa_answer_created:${answer?.qaResponseId}:${answer?.qaResponseId}`);
  expect(event?.eventKey).toBe(`event_review_requested:${event?.eventRequestId}:${event?.eventRequestId}`);
  const [seeded] = await db.select().from(notifications).where(and(
    eq(notifications.recipientId, id("poc_school")), eq(notifications.kind, "notice_review_requested"),
  ));
  expect(seeded.eventKey).toBe(`notice_review_requested:${seeded.noticeRequestId}:${seeded.noticeRequestId}`);
});
