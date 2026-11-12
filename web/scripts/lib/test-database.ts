function parseDatabaseUrl(key: string, value: string | undefined): URL {
  if (!value?.trim()) {
    throw new Error(`${key} をテスト専用DBの接続情報で設定してください。`);
  }

  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname === "/" || !url.pathname) {
      throw new Error();
    }
    decodeURIComponent(url.pathname);
    return url;
  } catch {
    throw new Error(`${key} には有効なPostgreSQL接続URLが必要です。`);
  }
}

function databaseIdentity(url: URL): string {
  const hostname = url.hostname.toLowerCase().replace(/-pooler(?=\.)/, "");
  return `${hostname}:${url.port || "5432"}${decodeURIComponent(url.pathname)}`;
}

export function requireTestDatabaseUrl(environment: Readonly<Record<string, string | undefined>>): string {
  if (environment.NODE_ENV !== "test") {
    throw new Error("DB結合テストはNODE_ENV=testで実行してください。");
  }

  const testUrl = parseDatabaseUrl("TEST_DATABASE_URL", environment.TEST_DATABASE_URL);
  for (const key of ["DATABASE_URL", "DIRECT_DATABASE_URL"]) {
    if (environment[key] && databaseIdentity(parseDatabaseUrl(key, environment[key])) === databaseIdentity(testUrl)) {
      throw new Error(`TEST_DATABASE_URL は ${key} と異なるテスト専用DBを指定してください。`);
    }
  }

  return testUrl.toString();
}
