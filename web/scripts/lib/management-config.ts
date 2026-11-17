import { databaseConfig } from "../../src/db/config";
import { neonMigrationTarget } from "./neon-migration";

export function managementDatabaseConfig(environment: Readonly<Record<string, string | undefined>>) {
  const config = databaseConfig(environment, "DATABASE_URL_DIRECT");
  if (new URL(config.connectionString!).hostname.endsWith(".neon.tech")) {
    // Neonは直接接続URLに加えて、接続予定のホスト・DB名を別途照合する。
    neonMigrationTarget(environment);
  }
  return config;
}
