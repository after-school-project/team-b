import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { eq, sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { authOptions } from "../../src/auth/options";
import { authOrigin } from "../../src/auth/web-config";
import * as authSchema from "../../src/db/auth-schema";
import { auditLogs } from "../../src/db/moderation-schema";
import { communityUsers, identityRecords, profileRevisions, profiles } from "../../src/db/schema";
import { schoolUsernamePattern, withAccountCredentials } from "../lib/account-credentials";

const nonBlank = z.string().trim().min(1);
const issuanceInput = z.strictObject({
  username: z.string().regex(schoolUsernamePattern),
  displayName: nonBlank.refine((value) =>
    value.isWellFormed() && !/[\0\r\n\u2028\u2029]/.test(value) && [...value].length <= 50),
  baseRole: z.enum(["student", "alumni", "staff"]),
  schoolManager: z.boolean(),
  appManager: z.boolean(),
  isGraduating: z.boolean().default(false),
  schoolVerified: z.literal(true),
  privateRealName: nonBlank,
  schoolReference: nonBlank,
  verificationNote: nonBlank.optional(),
  department: nonBlank.optional(),
  entryYear: z.int().min(1).max(9999).optional(),
  graduationYear: z.int().min(1).max(9999).optional(),
}).refine(({ schoolManager, baseRole }) => !schoolManager || baseRole === "staff")
  .refine(({ isGraduating, baseRole }) => !isGraduating || baseRole === "student")
  .refine(({ entryYear, graduationYear }) =>
    entryYear === undefined || graduationYear === undefined || entryYear <= graduationYear);

class IssueAccountError extends Error {}

async function main() {
  const { values } = parseArgs({
    options: { input: { type: "string" }, output: { type: "string" } },
  });
  if (!values.input || !values.output) {
    throw new IssueAccountError("使い方: npm run account:issue -- --input <発行情報JSON> --output <新規の受渡用JSON>");
  }
  const outputPath = values.output;
  const input = issuanceInput.safeParse(JSON.parse(await readFile(values.input, "utf8")));
  if (!input.success) {
    throw new IssueAccountError(
      "発行情報の形式、表示名（前後の空白を除いて1〜50文字・改行不可）、所属と管理権限、学校確認の有無を確認してください。",
    );
  }
  const {
    username, displayName, privateRealName, schoolReference, verificationNote,
    department, entryYear, graduationYear, baseRole, schoolManager, appManager, isGraduating,
  } = input.data;
  const baseURL = authOrigin();
  await withAccountCredentials(username, outputPath, async (tx, password) => {
    // 同じログインIDでの並行発行を直列化し、重複時は認証処理を呼ばない。
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('team-b-account-issue'), hashtext(${username}))`);
    const [existing] = await tx.select({ id: authSchema.user.id }).from(authSchema.user)
      .where(eq(authSchema.user.username, username));
    if (existing) throw new IssueAccountError("このログインIDは発行済み、または使用中です。");

    const options = authOptions(drizzleAdapter(tx, { provider: "pg", schema: authSchema }));
    const auth = betterAuth({
      ...options,
      baseURL,
      logger: { disabled: true },
      emailAndPassword: { ...options.emailAndPassword, disableSignUp: false },
    });
    const { user } = await auth.api.signUpEmail({
      body: { username, name: displayName, email: `${username}@example.invalid`, password },
    });
    const userId = user.id;
    await tx.insert(communityUsers).values({
      userId, baseRole, schoolManager, appManager, isGraduating, eligibilityStatus: "verified",
    });
    await tx.insert(identityRecords).values({ userId, privateRealName, schoolReference, verificationNote });
    const [revision] = await tx.insert(profileRevisions).values({
      userId, revisionNo: 1, displayName, department, entryYear, graduationYear,
    }).returning({ id: profileRevisions.id });
    await tx.insert(profiles).values({ userId, currentRevisionId: revision.id });

    await tx.update(communityUsers).set({ provisioningStatus: "ready" })
      .where(eq(communityUsers.userId, userId));
    await tx.insert(auditLogs).values({
      systemAction: true,
      actionType: "account.issued",
      targetType: "user",
      targetId: userId,
    });
  });
  console.info("アカウントを発行しました。指定した受渡用ファイルを確認してください。");
}

main().catch((error: unknown) => {
  console.error(error instanceof IssueAccountError
    ? error.message
    : "アカウントを発行できませんでした。入力・接続設定・受渡用ファイルの出力先を確認してください。");
  process.exitCode = 1;
});
