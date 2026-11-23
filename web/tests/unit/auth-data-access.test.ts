import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { cursorTimestamp, queryListPage } from "../../src/api/pagination";
import { qaQuestions } from "../../src/db/content-schema";
import { ApiError } from "../../src/api/response";
import { notifications } from "../../src/db/moderation-schema";
import { isOwner, ownedBy, requireOwned } from "../../src/auth/ownership";
import {
  projectOptionalProfileFields, publishedEvent, publishedNotice, retainedDeletedNotice, visibleQuestion,
} from "../../src/auth/visibility";

/** 所有者・公開範囲・対象状態による取得制御の共通処理（#7 ④）。 */

const dialect = new PgDialect();
function render(condition: SQL) {
  const { sql: text, params } = dialect.sqlToQuery(condition);
  return { sql: text, params };
}
const viewer = { userId: "u1" };

function notFound(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return (error as ApiError).code;
  }
  throw new Error("拒否されませんでした");
}

describe("所有者による本人判定", () => {
  it("セッションの利用者IDとDBの所有者IDが一致する場合だけ本人とする", () => {
    expect(isOwner(viewer, "u1")).toBe(true);
    expect(isOwner(viewer, "u2")).toBe(false);
    expect(isOwner(viewer, null)).toBe(false);
    expect(isOwner(viewer, undefined)).toBe(false);
  });

  it("本人用の取得条件は、所有者列をセッションの利用者IDで絞る", () => {
    expect(render(ownedBy(notifications.recipientId, viewer)))
      .toEqual({ sql: '"notifications"."recipient_id" = $1', params: ["u1"] });
  });

  it("AC-06：他人のデータと存在しないデータを、同じ 404 NOT_FOUND で拒否する", () => {
    const owner = (row: { ownerId: string | null }) => row.ownerId;
    expect(requireOwned({ ownerId: "u1" }, owner, viewer)).toEqual({ ownerId: "u1" });
    expect(notFound(() => requireOwned({ ownerId: "u2" }, owner, viewer))).toBe("NOT_FOUND");
    expect(notFound(() => requireOwned(undefined, owner, viewer))).toBe("NOT_FOUND");
    expect(notFound(() => requireOwned(null, owner, viewer))).toBe("NOT_FOUND");
    expect(notFound(() => requireOwned({ ownerId: null }, owner, viewer))).toBe("NOT_FOUND");
  });
});

describe("対象状態による取得条件", () => {
  it("Q&Aは強制非表示・削除済みを除く", () => {
    expect(render(visibleQuestion()).sql)
      .toBe('("qa_questions"."forced_hidden_at" is null and "qa_questions"."deleted_at" is null)');
  });

  it("お知らせは公開版があり、強制非表示・削除済みでないものに限る", () => {
    expect(render(publishedNotice()).sql).toBe(
      '("notices"."public_revision_id" is not null and "notices"."forced_hidden_at" is null'
      + ' and "notices"."deleted_at" is null)',
    );
  });

  it("イベントは公開版があり、強制非表示でないものに限る（終了・中止は含める）", () => {
    expect(render(publishedEvent()).sql)
      .toBe('("events"."public_revision_id" is not null and "events"."forced_hidden_at" is null)');
  });

  it("削除済みお知らせは削除から180日の期間内に限り、基準時刻を指定できる", () => {
    const now = new Date("2026-11-23T00:00:00.000Z");
    const query = render(retainedDeletedNotice(now));
    expect(query.sql).toContain('"notices"."deleted_at" is not null');
    expect(query.sql).toContain('"notices"."deleted_at" > $1::timestamptz - make_interval(days => $2)');
    expect(query.params).toEqual(["2026-11-23T00:00:00.000Z", 180]);
    expect(render(retainedDeletedNotice()).sql).toContain("now() - make_interval");
  });
});

describe("プロフィールの任意項目の返却範囲", () => {
  const revision = {
    optionalValues: { bio: "公開する自己紹介", occupation: "本人だけの職業", interests: "未設定の公開範囲" },
    fieldVisibility: { bio: "members", occupation: "self" },
  } as const;

  it("本人には全項目を返し、公開範囲が未設定の項目は本人のみとして扱う", () => {
    expect(projectOptionalProfileFields(revision, "owner")).toEqual({
      bio: { value: "公開する自己紹介", visibility: "members" },
      occupation: { value: "本人だけの職業", visibility: "self" },
      interests: { value: "未設定の公開範囲", visibility: "self" },
    });
  });

  it("AC-07：本人以外には全利用者に公開する項目だけを返し、本人のみの項目はキーごと省略する", () => {
    const projected = projectOptionalProfileFields(revision, "member");
    expect(projected).toEqual({ bio: { value: "公開する自己紹介", visibility: "members" } });
    expect(JSON.stringify(projected)).not.toContain("本人だけの職業");
    expect(JSON.stringify(projected)).not.toContain("未設定の公開範囲");
  });

  it("保存値に未知のキーがあっても返さない", () => {
    const projected = projectOptionalProfileFields({
      optionalValues: { bio: "自己紹介", secret: "未知の値" } as never,
      fieldVisibility: { bio: "members", secret: "members" } as never,
    }, "owner");
    expect(Object.keys(projected)).toEqual(["bio"]);
  });

  it("値も公開範囲もない項目は返さない", () => {
    expect(projectOptionalProfileFields({ optionalValues: {}, fieldVisibility: {} }, "owner")).toEqual({});
    expect(projectOptionalProfileFields({ optionalValues: {}, fieldVisibility: { bio: "members" } }, "member"))
      .toEqual({ bio: { visibility: "members" } });
  });
});

type RowsQuery = (where: SQL, take: number) => Promise<{ id: string }[]>;
type CountQuery = (where: SQL) => Promise<number>;

describe("認可条件を適用した一覧", () => {
  const authorized = sql`"owner_id" = ${"u1"}`;

  it("件数と各ページに認可条件を必ず適用し、括弧のない OR の条件でも認可条件が外れない", async () => {
    const rows = vi.fn<RowsQuery>(async () => [{ id: "a" }, { id: "b" }, { id: "c" }]);
    const count = vi.fn<CountQuery>(async () => 7);
    const page = await queryListPage({
      authorized, filters: sql`"title" = ${"x"} OR true`, after: sql`"id" > ${"z"}`,
      limit: 2, rows, count, cursorFor: (last) => "cursor:" + last.id,
    });

    expect(rows).toHaveBeenCalledWith(expect.anything(), 3);
    expect(render(rows.mock.calls[0][0])).toEqual({
      sql: '(("owner_id" = $1) AND ("title" = $2 OR true)) AND ("id" > $3)', params: ["u1", "x", "z"],
    });
    // 件数にはカーソル位置を適用しない。
    expect(render(count.mock.calls[0][0])).toEqual({
      sql: '("owner_id" = $1) AND ("title" = $2 OR true)', params: ["u1", "x"],
    });
    expect(page).toEqual({
      data: { items: [{ id: "a" }, { id: "b" }] },
      page: { limit: 2, hasMore: true, nextCursor: "cursor:b", totalCount: 7 },
    });
  });

  it("検索条件・カーソルがなければ認可条件だけで取得し、最後のページにはカーソルを返さない", async () => {
    const rows = vi.fn<RowsQuery>(async () => [{ id: "a" }]);
    const count = vi.fn<CountQuery>(async () => 1);
    const page = await queryListPage({ authorized, limit: 20, rows, count, cursorFor: () => "unused" });
    expect(render(rows.mock.calls[0][0]).sql).toBe('(("owner_id" = $1))');
    expect(page.page).toEqual({ limit: 20, hasMore: false, nextCursor: null, totalCount: 1 });
  });

  it("カーソルの日時は、DBでマイクロ秒までの UTC の文字列にする（Date を経由しない）", () => {
    expect(render(cursorTimestamp(qaQuestions.createdAt)).sql)
      .toBe(`to_char("qa_questions"."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
  });

  it("取得件数が上限を超えたら、誤った件数のまま返さない", async () => {
    await expect(queryListPage({
      authorized, limit: 1, rows: async () => [{}, {}, {}], count: async () => 3, cursorFor: () => "c",
    })).rejects.toThrow("上限");
  });
});
