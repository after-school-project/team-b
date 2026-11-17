type Environment = Readonly<Record<string, string | undefined>>;

function neonUrl(value: string | undefined, key: string): URL {
  try {
    const url = new URL(value ?? "");
    const sslModes = url.searchParams.getAll("sslmode");
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname.endsWith(".neon.tech") || !url.username || !url.password ||
      !url.pathname.slice(1) || url.hash || (url.port && url.port !== "5432") ||
      sslModes.length !== 1 || !["require", "verify-full"].includes(sslModes[0]) ||
      [...url.searchParams.keys()].some((name) => !["sslmode", "channel_binding"].includes(name)) ||
      (url.searchParams.has("channel_binding") &&
        (url.searchParams.getAll("channel_binding").length !== 1 || url.searchParams.get("channel_binding") !== "require"))
    ) throw new Error();
    decodeURIComponent(url.pathname);
    return url;
  } catch {
    throw new Error(`${key} にTLSを有効にしたNeon接続URLを設定してください。`);
  }
}

export function productionPocConfig(environment: Environment) {
  const database = neonUrl(environment.DATABASE_URL, "DATABASE_URL");
  // Neon連携が登録する名前をそのまま使える。管理コマンドは引き続きDIRECTを使用する。
  const direct = neonUrl(environment.DATABASE_URL_DIRECT ?? environment.DATABASE_URL_UNPOOLED,
    "DATABASE_URL_DIRECT または DATABASE_URL_UNPOOLED");
  const identity = (url: URL) => `${url.hostname.replace(/-pooler(?=\.)/, "")}${decodeURIComponent(url.pathname)}`;
  if (direct.hostname.split(".")[0].endsWith("-pooler") || identity(database) !== identity(direct)) {
    throw new Error("アプリ用と直接接続用のURLは同じPoC用Neon DBを指定してください。");
  }
  const secret = environment.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32 || secret === "team-b-compose-local-development-only") {
    throw new Error("BETTER_AUTH_SECRET にローカルと異なる32文字以上の秘密値を設定してください。");
  }
  try {
    const url = new URL(environment.BETTER_AUTH_URL ?? "");
    if (url.protocol !== "https:" || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash || url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") || url.hostname === "127.0.0.1" || url.hostname === "[::1]") throw new Error();
  } catch {
    throw new Error("BETTER_AUTH_URL にPoC公開先のHTTPSオリジンを設定してください。");
  }
  return { connectionString: database.toString() };
}

export function shouldVerifyProduction(environment: Environment): boolean {
  if (environment.VERCEL_ENV === "production") return true;
  if (environment.VERCEL_ENV === "preview" || environment.VERCEL_ENV === "development" || !environment.VERCEL) return false;
  throw new Error("Vercelの実行環境を確認できません。");
}
