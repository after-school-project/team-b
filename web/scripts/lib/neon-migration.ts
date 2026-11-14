type Environment = Readonly<Record<string, string | undefined>>;

export function neonMigrationTarget(environment: Environment) {
  const required = ["DATABASE_URL_DIRECT", "NEON_EXPECTED_HOST", "NEON_EXPECTED_DATABASE"];
  const missing = required.filter((key) => !environment[key]?.trim());
  if (missing.length) throw new Error(`必要な環境変数: ${missing.join(", ")}`);

  let url: URL;
  let database: string;
  try {
    url = new URL(environment.DATABASE_URL_DIRECT!);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error("DATABASE_URL_DIRECTが有効な接続URLではありません。");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname.endsWith(".neon.tech") ||
    url.hostname.split(".")[0].endsWith("-pooler") ||
    (url.port && url.port !== "5432") ||
    !url.username || !url.password || !database || url.hash
  ) {
    throw new Error("Neonの管理用ロールの直接接続URLを指定してください。");
  }
  if (
    url.hostname !== environment.NEON_EXPECTED_HOST!.trim().toLowerCase() ||
    database !== environment.NEON_EXPECTED_DATABASE!.trim()
  ) {
    throw new Error("接続URLとNEON_EXPECTED_HOST・NEON_EXPECTED_DATABASEが一致しません。");
  }
  const sslModes = url.searchParams.getAll("sslmode");
  const binding = url.searchParams.getAll("channel_binding");
  if (
    sslModes.length !== 1 || !["require", "verify-full"].includes(sslModes[0]) ||
    binding.length > 1 || (binding.length === 1 && binding[0] !== "require") ||
    [...url.searchParams.keys()].some((key) => !["sslmode", "channel_binding"].includes(key))
  ) {
    throw new Error("接続URLにはsslmode=requireまたはverify-fullを指定してください。追加設定はchannel_binding=requireのみ対応しています。");
  }
  return { connectionString: url.toString(), host: url.hostname, database };
}

export function neonMigrationMode(args: string[]) {
  if (args.length !== 1 || !["--check", "--apply"].includes(args[0])) {
    throw new Error("Usage: neon-migrate.ts --check | --apply");
  }
  return args[0] as "--check" | "--apply";
}
