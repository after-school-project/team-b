import { inspect } from "node:util";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api/response";

vi.mock("server-only", () => ({}));
vi.mock("../../src/db/client", () => ({ db: { marker: "database" } }));

const { readForScreen, ScreenReadError, withSafeScreenErrors } = await import("../../src/db/screen-read");

const secret = "secret-session-token";

/** サーバーログに出る内容。Next.js は描画中の例外を console.error に渡す。 */
async function logged(failure: unknown): Promise<string> {
  const error: unknown = await withSafeScreenErrors(async () => { throw failure; }).catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(ScreenReadError);
  return inspect(error, { depth: null, showHidden: true });
}

describe("画面の読み取りの失敗", () => {
  it("DBの例外のSQL・引数を残さず、エラーコードと呼び出し元だけを残す", async () => {
    const cause = Object.assign(new Error(`connect ECONNREFUSED ${secret}`), { code: "ECONNREFUSED", detail: secret });
    const output = await logged(new DrizzleQueryError('select * from "session" where "token" = $1', [secret], cause));
    expect(output).not.toContain(secret);
    expect(output).not.toContain("select");
    expect(output).toContain("ScreenReadError: 画面の表示に必要な処理に失敗しました。（ECONNREFUSED）");
    expect(output).toContain("screen-read.test.ts");
  });

  it("スタックのない例外で包まれていても、元の例外のコードと呼び出し元だけを残す", async () => {
    const pgError = Object.assign(new Error(`relation ${secret}`), { code: "42P01" });
    // Better Auth は、DBの例外をスタックのない例外で包む。
    const wrapper = new Error("Failed to get session", {
      cause: new DrizzleQueryError("select $1", [secret], pgError),
    });
    wrapper.stack = "";
    const output = await logged(wrapper);
    expect(output).not.toContain(secret);
    expect(output).toContain("（42P01）");
    expect(output).toContain("screen-read.test.ts");
  });

  it("改行や呼び出し元の行に似た値が引数に含まれていても残さない", async () => {
    const output = await logged(new DrizzleQueryError("select $1", [`x\n    at ${secret} (file.ts:1:1)`], new Error("down")));
    expect(output).not.toContain(secret);
  });

  it("メッセージの範囲が分からない場合と、形式の違うコードは残さない", async () => {
    const failure = Object.assign(new Error("before"), { code: secret });
    void failure.stack;
    failure.message = `after ${secret}`;
    failure.stack = `Error: ${secret}\n    at ${secret}`;
    const output = await logged(failure);
    expect(output).not.toContain(secret);
    expect(output).toContain("（Error）");
  });

  it.each([secret, { token: secret }, null, undefined])("Error 以外（%j）が投げられても値を残さない", async (failure) => {
    const output = await logged(failure);
    expect(output).not.toContain(secret);
    expect(output).toContain("（UNKNOWN）");
  });

  it("循環した cause でも停止しない", async () => {
    const failure = new Error("loop");
    failure.cause = failure;
    expect(await logged(failure)).toContain("（Error）");
  });

  it("画面が扱う ApiError と、成功した結果はそのまま返す", async () => {
    const notFound = new ApiError("NOT_FOUND");
    await expect(withSafeScreenErrors(async () => { throw notFound; })).rejects.toBe(notFound);
    await expect(readForScreen(async (db) => db)).resolves.toEqual({ marker: "database" });
  });
});
