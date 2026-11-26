export const signOutError =
  "ログアウトできませんでした。時間をおいてもう一度お試しください。";

/** セッション失効をHTTP応答で確認できたときだけtrueを返す。 */
export async function requestSignOut(): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    return response.ok;
  } catch {
    return false;
  }
}
