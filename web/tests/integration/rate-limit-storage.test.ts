import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrateDatabase } from "../../scripts/lib/database-management";
import { fixedWindowRateLimitStorage } from "../../src/auth/rate-limit-storage";
import { isolatedDatabase } from "./isolated-database";

const rule = { window: 60, max: 3 };
const start = Date.UTC(2026, 10, 20, 0, 0, 0);
let target: Awaited<ReturnType<typeof isolatedDatabase>>;
let pool: Pool;

beforeAll(async () => {
  target = await isolatedDatabase();
  await migrateDatabase(target.client);
  pool = new Pool({ connectionString: target.url.toString() });
});

afterAll(async () => {
  await pool?.end();
  await target?.dispose();
});

/** 時刻を指定して試行できる保存処理。 */
function storageAt() {
  let current = start;
  const storage = fixedWindowRateLimitStorage(drizzle(pool), () => current);
  return {
    at: (offsetMs: number) => {
      current = start + offsetMs;
      return storage;
    },
  };
}

async function storedCount(key: string) {
  const result = await target.client.query<{ count: number }>("SELECT count FROM rate_limit WHERE key = $1", [key]);
  return result.rows[0]?.count;
}

it("時間窓の起点から上限まで受け付け、超えた試行は起点からの残り秒数で拒否する", async () => {
  const key = "192.0.2.21|/sign-in/username";
  const clock = storageAt();
  for (let attempt = 0; attempt < rule.max; attempt++) {
    expect(await clock.at(attempt * 1000).consume(key, rule)).toEqual({ allowed: true, retryAfter: null });
  }
  expect(await clock.at(10_000).consume(key, rule)).toEqual({ allowed: false, retryAfter: 50 });
  expect(await clock.at(59_500).consume(key, rule)).toEqual({ allowed: false, retryAfter: 1 });
  // 拒否した試行は上限+1で止め、回数が増え続けないようにする。
  expect(await storedCount(key)).toBe(rule.max + 1);
});

it("時間窓の起点から60秒たつと、拒否中でも制限を解除して1から数え直す", async () => {
  const key = "192.0.2.22|/sign-in/username";
  const clock = storageAt();
  for (let attempt = 0; attempt <= rule.max; attempt++) await clock.at(0).consume(key, rule);
  expect((await clock.at(59_999).consume(key, rule)).allowed).toBe(false);

  expect(await clock.at(60_000).consume(key, rule)).toEqual({ allowed: true, retryAfter: null });
  expect(await storedCount(key)).toBe(1);
});

it("試行が途切れずに複数分続いても、各時間窓の回数が上限以内なら拒否しない", async () => {
  const key = "192.0.2.23|/sign-in/username";
  const clock = storageAt();
  // 25秒おきに5分間試行する。1つの時間窓には最大3件で、上限を超えない。
  // 最後に受け付けた試行から60秒空くまで数え直さない方式では、4件目で拒否される。
  for (let offset = 0; offset <= 300_000; offset += 25_000) {
    expect((await clock.at(offset).consume(key, rule)).allowed).toBe(true);
  }
});

it("同時の試行でも上限を超えて受け付けない", async () => {
  const key = "192.0.2.24|/sign-in/username";
  const clock = storageAt().at(0);
  const results = await Promise.all(Array.from({ length: 10 }, () => clock.consume(key, rule)));
  expect(results.filter((result) => result.allowed)).toHaveLength(rule.max);
  expect(await storedCount(key)).toBe(rule.max + 1);
});

it("送信元と経路ごとに別々に数える", async () => {
  const clock = storageAt().at(0);
  for (let attempt = 0; attempt <= rule.max; attempt++) await clock.consume("192.0.2.25|/sign-in/username", rule);
  expect((await clock.consume("192.0.2.26|/sign-in/username", rule)).allowed).toBe(true);
  expect((await clock.consume("192.0.2.25|/get-session", rule)).allowed).toBe(true);
});
