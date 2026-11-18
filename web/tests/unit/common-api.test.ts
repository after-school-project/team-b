import { getCookies } from "better-auth/cookies";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { authOrigin, authWebOptions } from "../../src/auth/web-config";
import { createCursorCodec, listPage, parseListQuery } from "../../src/api/pagination";
import {
  expectedVersion, isoDateTime, longText, maxJsonBytes, normalizedPath, parsePathParams,
  parseQuery, readJson, shortText, title, userId, uuid,
} from "../../src/api/request";
import { ApiError, rateLimited } from "../../src/api/response";
import { defineApiRoute } from "../../src/api/route";

const origin = "https://school.example";
const url = origin + "/api/v1/probe";
const environment = { BETTER_AUTH_URL: origin, NODE_ENV: "production" };
const schema = z.object({ expectedVersion, nested: z.strictObject({ name: title }).optional() });
const update = async (request: Request) => ({ data: await readJson(request, schema), status: 201 as const });
const route = defineApiRoute({ GET: () => ({ data: { ok: true } }), POST: update, PATCH: update }, environment);
const body = '{"expectedVersion":1}';
const headers = { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": "example-key" };

function post(payload: BodyInit = body, overrides: Partial<Record<string, string>> = {}) {
  return route.POST(new Request(url, { method: "POST", headers: { ...headers, ...overrides }, body: payload }), {});
}

function expectMeta(meta: { requestId: string; serverTime: string }) {
  expect(uuid.safeParse(meta.requestId).success).toBe(true);
  expect(new Date(meta.serverTime).toISOString()).toBe(meta.serverTime);
}

describe("業務 Route Handler", () => {
  it("成功とエラーにメタ情報とキャッシュ制御を付け、リクエストごとに別IDを発行する", async () => {
    const success = await route.GET(new Request(url, { headers: { "X-Request-Id": "client-request" } }), {});
    const valid = await post();
    const failed = await post("{");
    const [get, posted, error] = await Promise.all([success.json(), valid.json(), failed.json()]);
    for (const response of [success, valid, failed]) {
      expect(response.headers.get("Content-Type")).toContain("application/json");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(success.status).toBe(200);
    expect(valid.status).toBe(201);
    expect(get).toEqual({ data: { ok: true }, meta: expect.any(Object) });
    expect(posted.data).toEqual({ expectedVersion: 1 });
    expect(error.error).toMatchObject({ code: "BAD_REQUEST", message: expect.any(String), fields: [] });
    for (const { meta } of [get, posted, error]) expectMeta(meta);
    expect(new Set([get.meta.requestId, posted.meta.requestId, error.meta.requestId]).size).toBe(3);
  });

  it.each(["PUT", "DELETE", "OPTIONS", "HEAD"] as const)("%s を405とAllowで拒否する", async (method) => {
    const response = await route[method](new Request(url, { method }), {});
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, POST, PATCH");
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
    expect((await response.json()).error.code).toBe("METHOD_NOT_ALLOWED");
  });

  it.each(["GET", "POST", "PATCH"] as const)("共通APIの業務メソッド %s もルートで未定義なら405にする", async (method) => {
    const allow = method === "GET" ? "POST" : "GET";
    const handler = defineApiRoute({ [allow]: () => ({ data: { ok: true } }) }, environment);
    const response = await handler[method](new Request(url, { method }), {});
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe(allow);
    expect((await response.json()).error.code).toBe("METHOD_NOT_ALLOWED");
  });

  it.each([undefined, "", "null", "https://attacker.example", origin + "/", origin + ", https://other.example",
    "http://localhost:3000"])("許可外のOrigin %s を拒否する", async (candidate) => {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("Host", "attacker.example");
    requestHeaders.set("X-Forwarded-Host", "attacker.example");
    if (candidate === undefined) requestHeaders.delete("Origin");
    else requestHeaders.set("Origin", candidate);
    const response = await route.PATCH(new Request("https://attacker.example/api/v1/probe", {
      method: "PATCH", body, headers: requestHeaders,
    }), {});
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("ORIGIN_NOT_ALLOWED");
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });

  it.each(["text/plain", "application/x-www-form-urlencoded", "application/jsonp", "application/json; charset=utf-16", ""])(
    "JSON以外のContent-Type %s を415にする", async (mediaType) => {
      const response = await post(body, { "Content-Type": mediaType });
      expect(response.status).toBe(415);
      expect((await response.json()).error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    },
  );

  it.each(["", "short", "a".repeat(129), "two-keys, another-key", "invalid/characters"])(
    "不正な再送キー %s を拒否する", async (key) => {
      expect((await post(body, { "Idempotency-Key": key })).status).toBe(400);
    },
  );

  it("JSONの不正とスキーマ違反を区別し、未知フィールドを入れ子でも拒否する", async () => {
    expect((await post(new Uint8Array([0xc3, 0x28]))).status).toBe(400);
    for (const input of [
      "null", "[]", '{"expectedVersion":"1"}', '{"expectedVersion":0}',
      '{"expectedVersion":1,"actorId":"other"}', '{"expectedVersion":1,"nested":{"name":"a","administrator":true}}',
    ]) {
      const response = await post(input);
      expect(response.status).toBe(422);
      expect((await response.json()).error).toMatchObject({
        code: "VALIDATION_FAILED",
        fields: [{ path: expect.any(String), code: expect.any(String), message: expect.any(String) }],
      });
    }
    const response = await post('{"expectedVersion":1,"nested":{"name":" 名前 "}}', {
      "Content-Type": 'Application/JSON; charset="UTF-8"',
    });
    expect((await response.json()).data.nested.name).toBe("名前");
  });

  it.each([
    { name: "NUL", character: "\0" },
    { name: "対応する下位サロゲートのない文字", character: "\uD800" },
  ])("JSONでエスケープされた $name を含むタイトルや本文を422にする", async ({ character }) => {
    const textSchema = z.object({ title, body: longText, comment: shortText });
    const handler = defineApiRoute({
      POST: async (request) => ({ data: await readJson(request, textSchema) }),
    }, environment);
    const invalid = `前${character}後`;
    const request = new Request(url, {
      method: "POST", headers, body: JSON.stringify({ title: invalid, body: invalid, comment: invalid }),
    });
    const response = await handler.POST(request, {});
    expect(response.status).toBe(422);
    const { error } = await response.json();
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.fields.map(({ path }: { path: string }) => path).sort()).toEqual(["body", "comment", "title"]);
  });

  it("Content-LengthにかかわらずUTF-8の実バイト数で128 KiBを上限にする", async () => {
    expect((await post(body + " ".repeat(maxJsonBytes - body.length))).status).toBe(201);
    expect((await post(body + " ".repeat(maxJsonBytes - body.length + 1), { "Content-Length": "20" })).status).toBe(413);
    expect((await post(body, { "Content-Length": String(maxJsonBytes + 1) })).status).toBe(413);
    const text = '{"expectedVersion":1,"nested":{"name":"' + "あ".repeat(45_000) + '"}}';
    expect(text.length).toBeLessThan(maxJsonBytes);
    const response = await post(text);
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("内部エラーとDBの一時障害で原因・SQL・秘密値を応答やログへ含めない", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const sensitive = "SELECT secret FROM postgres://private:test@db";
    const queryError = new Error(sensitive, { cause: Object.assign(new Error(sensitive), { code: "55P03" }) });
    for (const [reason, status, code] of [
      [new Error(sensitive), 500, "INTERNAL_ERROR"], [queryError, 503, "TEMPORARILY_UNAVAILABLE"],
    ] as const) {
      const handler = defineApiRoute({ GET: () => { throw reason; } });
      const response = await handler.GET(new Request(url), {});
      const result = await response.text();
      expect(response.status).toBe(status);
      expect(result).not.toContain(sensitive);
      const parsed = JSON.parse(result);
      expect(parsed.error).toMatchObject({ code, fields: [] });
      expect(log).toHaveBeenLastCalledWith(expect.any(String), { requestId: parsed.meta.requestId, code });
    }
  });

  it("429には再試行の秒数を付ける", async () => {
    const handler = defineApiRoute({ GET: () => { throw rateLimited(2.2); } });
    const result = await handler.GET(new Request(url), {});
    expect(result.status).toBe(429);
    expect(result.headers.get("Retry-After")).toBe("3");
  });
});

describe("オリジンとCookie", () => {
  it("HTTPSの固定Originを共有し、公開・PreviewでローカルHTTPを拒否する", () => {
    expect(authOrigin({ ...environment, BETTER_AUTH_URL: origin + "/" })).toBe(origin);
    for (const invalid of [
      undefined, "", "https://*.example.com", "https://name:password@school.example",
      origin + "/auth", origin + "?", origin + "#", "http://localhost:3000",
    ]) expect(() => authOrigin({ ...environment, BETTER_AUTH_URL: invalid })).toThrow("BETTER_AUTH_URL");
    expect(() => authOrigin({
      NODE_ENV: "development", VERCEL_ENV: "preview", BETTER_AUTH_URL: "http://localhost:3000",
    })).toThrow("BETTER_AUTH_URL");
  });

  it("Better Authの実際のセッションCookie定義で環境ごとの属性を確認する", () => {
    const local = { NODE_ENV: "development", BETTER_AUTH_URL: "http://localhost:3000" };
    expect(() => authOrigin({ ...local, BETTER_AUTH_URL: "http://school.example" })).toThrow("BETTER_AUTH_URL");
    for (const [configured, secure] of [[environment, true], [local, false]] as const) {
      const options = authWebOptions(configured);
      expect(options.trustedOrigins).toEqual([configured.BETTER_AUTH_URL]);
      expect(getCookies(options).sessionToken.attributes).toMatchObject({ secure, httpOnly: true, sameSite: "lax" });
    }
  });
});

describe("共通入力とページング", () => {
  it("パスを正規化し、IDや日時の形式と文字数を検証する", () => {
    expect(normalizedPath("/api/v1/%E6%97%A5%2da")).toBe("/api/v1/%E6%97%A5-a");
    for (const path of ["/api//v1", "/api/%2F", "/api/%5c", "/api/%00", "/api/%GG", "/api/.."]) {
      expect(() => normalizedPath(path)).toThrow(ApiError);
    }
    expect(parsePathParams({ id: "opaque-id" }, { id: userId })).toEqual({ id: "opaque-id" });
    for (const value of ["", "a/b", "a\u0000", "a\u0085", "𠮷".repeat(129)]) {
      expect(() => parsePathParams({ id: value }, { id: userId })).toThrow(ApiError);
    }
    expect(isoDateTime.parse("2026-11-18T01:00:00+09:00")).toBe("2026-11-17T16:00:00.000Z");
    for (const value of ["2026-11-18", "2026-11-18T01:00:00", "2026-02-30T01:00:00Z"]) {
      expect(isoDateTime.safeParse(value).success).toBe(false);
    }
    expect(shortText.parse("前\r\n後  ")).toBe("前\n後  ");
    expect(title.safeParse("𠮷".repeat(100)).success).toBe(true);
    expect(title.safeParse("𠮷".repeat(101)).success).toBe(false);
  });

  it("一覧の既定値、範囲、未知および重複クエリーを検証する", () => {
    const filters = { sort: z.enum(["name", "date"]).default("name") };
    expect(parseListQuery(new URL(url), filters)).toEqual({ limit: 20, sort: "name" });
    expect(parseListQuery(new URL(url + "?limit=50&sort=date"), filters)).toEqual({ limit: 50, sort: "date" });
    for (const query of ["limit=0", "limit=51", "limit=1.5", "limit=1e1", "limit=%2020", "limit=20&limit=21",
      "unexpected=x", "sort=unknown", "__proto__=x"]) {
      expect(() => parseListQuery(new URL(url + "?" + query), filters)).toThrow(ApiError);
    }
    expect(() => parseQuery(new URL(url + "?q=x"), {})).toThrow(ApiError);
  });

  it("利用者・一覧・検索条件・ソートに署名を結び付け、改ざんと取り違えを拒否する", () => {
    const scope = { actorId: "alice", list: "profiles", sort: "name", filters: { department: "情報", q: "検索" } };
    const position = z.tuple([z.string(), userId]);
    const create = (overrides = {}) => createCursorCodec({ ...scope, ...overrides }, position, "test-signing-key-".repeat(3));
    const codec = create();
    const token = codec.encode(["例", "person-a"]);
    expect(codec.decode(undefined)).toBeNull();
    expect(create({ filters: { q: "検索", department: "情報" } }).decode(token)).toEqual(["例", "person-a"]);
    for (const changed of [
      { actorId: "bob" }, { list: "questions" }, { sort: "date" }, { filters: { q: "another" } },
    ]) expect(() => create(changed).decode(token)).toThrow(new ApiError("INVALID_CURSOR").message);
    expect(() => codec.decode((token.startsWith("A") ? "B" : "A") + token.slice(1))).toThrow(ApiError);
    expect(() => codec.decode("")).toThrow(ApiError);
    expect(listPage(["a", "b", "c"], 2, 6, (last) => codec.encode([last, "id"]))).toEqual({
      data: { items: ["a", "b"] }, page: { limit: 2, hasMore: true, nextCursor: codec.encode(["b", "id"]), totalCount: 6 },
    });
    expect(listPage([], 2, 0, String).page).toEqual({ limit: 2, hasMore: false, nextCursor: null, totalCount: 0 });
  });
});
