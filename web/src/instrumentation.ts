export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // ビルドはDB不要。サーバー起動時は不足設定を直ちに検出する。
    const { applicationPool } = await import("./db/pool");
    const { requireApplicationRole } = await import("./db/permissions");
    try {
      await requireApplicationRole(applicationPool());
    } catch {
      throw new Error("DBの起動確認に失敗しました。DATABASE_URL、TLS、専用アプリ用ロールの権限を確認してください。");
    }
  }
}
