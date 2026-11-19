import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { parseArgs } from "node:util";
import { account, session, user } from "../../src/db/auth-schema";
import { auditLogs } from "../../src/db/moderation-schema";
import { communityUsers } from "../../src/db/schema";
import { schoolUsernamePattern, withAccountCredentials } from "../lib/account-credentials";

class ResetPasswordError extends Error {}

async function main() {
  const { values } = parseArgs({
    options: { username: { type: "string" }, output: { type: "string" } },
  });
  const { username, output } = values;
  if (!username || !schoolUsernamePattern.test(username) || !output) {
    throw new ResetPasswordError(
      "使い方: npm run account:reset-password -- --username <ログインID> --output <新規の受渡用JSON>",
    );
  }

  await withAccountCredentials(username, output, async (tx, password) => {
    // 同じ対象への再発行を直列化する。業務データは参照だけに使う。
    const credentials = await tx.select({ id: account.id, userId: account.userId, password: account.password })
      .from(account)
      .innerJoin(user, eq(user.id, account.userId))
      .innerJoin(communityUsers, eq(communityUsers.userId, user.id))
      .where(and(
        eq(user.username, username),
        eq(account.providerId, "credential"),
        eq(communityUsers.provisioningStatus, "ready"),
        eq(communityUsers.eligibilityStatus, "verified"),
      ))
      .for("update", { of: account });
    const [credential] = credentials;
    if (credentials.length !== 1 || !credential?.password) {
      throw new ResetPasswordError("再発行できる学校発行アカウントが見つかりません。");
    }

    // Better Authと同じハッシュを使い、資格情報とセッションをまとめて更新する。
    await tx.update(account).set({ password: await hashPassword(password) })
      .where(eq(account.id, credential.id));
    await tx.delete(session).where(eq(session.userId, credential.userId));
    await tx.insert(auditLogs).values({
      systemAction: true,
      actionType: "account.password_reset",
      targetType: "user",
      targetId: credential.userId,
    });
  });
  console.info("パスワードを再発行しました。指定した受渡用ファイルを確認してください。");
}

main().catch((error: unknown) => {
  console.error(error instanceof ResetPasswordError
    ? error.message
    : "パスワードを再発行できませんでした。入力・接続設定・受渡用ファイルの出力先を確認してください。");
  process.exitCode = 1;
});
