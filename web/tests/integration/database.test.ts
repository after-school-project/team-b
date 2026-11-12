import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, expect, it } from "vitest";
import { requireTestDatabaseUrl } from "../../scripts/lib/test-database";

const pool = new Pool({
  connectionString: requireTestDatabaseUrl(process.env),
  max: 1,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 5_000,
});
const db = drizzle(pool);

afterAll(async () => { await pool.end(); });

it("pgとDrizzleで読み書きし、失敗したトランザクションをロールバックする", async () => {
  const rollback = new Error("intentional-test-rollback");
  await expect(db.transaction(async (tx) => {
    await tx.execute(sql`create temporary table toolchain_probe (value integer not null) on commit drop`);
    await tx.execute(sql`insert into toolchain_probe (value) values (42)`);
    const result = await tx.execute<{ value: number }>(sql`select value from toolchain_probe`);
    expect(result.rows).toEqual([{ value: 42 }]);
    throw rollback;
  })).rejects.toBe(rollback);

  const result = await db.execute<{ relation: string | null }>(
    sql`select to_regclass('pg_temp.toolchain_probe')::text as relation`,
  );
  expect(result.rows[0].relation).toBeNull();
});
