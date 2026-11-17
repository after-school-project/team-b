import type { PoolConfig } from "pg";

type Environment = Readonly<Record<string, string | undefined>>;

// URL由来の例外は秘密値を含むことがあるため、入力を添えず固定文言で返す。
export function databaseConfig(environment: Environment, key = "DATABASE_URL"): PoolConfig {
  try {
    const url = new URL(environment[key] ?? "");
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.username || !url.password ||
      !url.pathname.slice(1) || url.hash) throw new Error();
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    decodeURIComponent(url.pathname);
    const local = ["db", "localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const neon = url.hostname.endsWith(".neon.tech");
    if ((!local && !neon) || (local && environment.VERCEL)) throw new Error();
    const modes = url.searchParams.getAll("sslmode");
    const binding = url.searchParams.getAll("channel_binding");
    if ([...url.searchParams.keys()].some((name) => !["sslmode", "channel_binding"].includes(name)) ||
      modes.length > 1 || binding.length > 1 || (binding.length && binding[0] !== "require")) throw new Error();
    if (local && (binding.length || (modes.length && modes[0] !== "disable"))) throw new Error();
    if (neon && (modes.length !== 1 || !["require", "verify-full"].includes(modes[0]))) throw new Error();
    if (key === "DATABASE_URL_DIRECT" && url.hostname.split(".")[0].endsWith("-pooler")) throw new Error();
    // pgはURLのsslmodeでsslオブジェクトを上書きするため、URLから取り除く。
    url.search = "";
    return {
      connectionString: url.toString(),
      ssl: neon ? { rejectUnauthorized: true } : false,
      enableChannelBinding: binding[0] === "require",
      max: 5,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
      application_name: key === "DATABASE_URL" ? "team-b-app" : "team-b-management",
    };
  } catch {
    throw new Error(`${key} に有効なDB接続情報を設定してください（ローカルPostgreSQL、またはTLS必須のNeon）。`);
  }
}
