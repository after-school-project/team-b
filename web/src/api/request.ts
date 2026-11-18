import { z } from "zod";
import { authOrigin } from "../auth/web-config";
import { ApiError } from "./response";

export const maxJsonBytes = 128 * 1024;
const idempotencyKey = /^[A-Za-z0-9_-]{8,128}$/;
const jsonContentType = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i;
const invalidPathCharacter = /[\p{Cc}/\\]/u;

export type MutationMethod = "POST" | "PATCH";
export type MutationRequest = { method: MutationMethod; path: string; requestKey: string };

function validSegment(value: string) {
  return value !== "" && value !== "." && value !== ".." &&
    value.isWellFormed() && !invalidPathCharacter.test(value);
}

export function normalizedPath(pathname: string): string {
  try {
    if (!pathname.startsWith("/")) throw new ApiError("BAD_REQUEST");
    const segments = pathname.slice(1).split("/").map(decodeURIComponent);
    if (!segments.every(validSegment)) throw new ApiError("BAD_REQUEST");
    return "/" + segments.map(encodeURIComponent).join("/");
  } catch {
    throw new ApiError("BAD_REQUEST");
  }
}

function requireJson(request: Request) {
  if (!jsonContentType.test(request.headers.get("Content-Type") ?? "")) {
    throw new ApiError("UNSUPPORTED_MEDIA_TYPE");
  }
}

export function validateMutationRequest(
  request: Request,
  method: MutationMethod,
  environment: Parameters<typeof authOrigin>[0],
): MutationRequest {
  if (request.headers.get("Origin") !== authOrigin(environment)) {
    throw new ApiError("ORIGIN_NOT_ALLOWED");
  }
  requireJson(request);
  const requestKey = request.headers.get("Idempotency-Key") ?? "";
  if (!idempotencyKey.test(requestKey)) throw new ApiError("BAD_REQUEST");
  const url = new URL(request.url);
  // Mutation inputs live in the JSON body. The idempotency fingerprint covers the path.
  if (url.search) throw new ApiError("BAD_REQUEST");
  return { method, path: normalizedPath(url.pathname), requestKey };
}

async function readBody(request: Request): Promise<string> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && !/^\d+$/.test(declared)) throw new ApiError("BAD_REQUEST");
  if (Number(declared) > maxJsonBytes) throw new ApiError("PAYLOAD_TOO_LARGE");
  if (!request.body) throw new ApiError("BAD_REQUEST");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxJsonBytes) throw new ApiError("PAYLOAD_TOO_LARGE");
      body += decoder.decode(chunk.value, { stream: true });
    }
    return body + decoder.decode();
  } catch (error) {
    // Do not wait for the sender to finish streaming an invalid request.
    void reader.cancel().catch(() => {});
    if (error instanceof ApiError) throw error;
    throw new ApiError("BAD_REQUEST");
  } finally {
    reader.releaseLock();
  }
}

export async function readJson<T extends z.ZodRawShape>(request: Request, schema: z.ZodObject<T>) {
  requireJson(request);
  const text = await readBody(request);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError("BAD_REQUEST");
  }
  const result = schema.strict().safeParse(body);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => {
      const path = issue.path.map(String).join(".");
      if (issue.code === "unrecognized_keys") {
        // Do not echo arbitrary sender-supplied keys.
        return { path, code: "unknown_field", message: "未定義の項目が含まれています。" };
      }
      return { path, code: issue.code, message: "入力値を確認してください。" };
    });
    throw new ApiError("VALIDATION_FAILED", { fields });
  }
  return result.data;
}

export function parsePathParams<T extends z.ZodRawShape>(params: unknown, shape: T) {
  const result = z.strictObject(shape).safeParse(params);
  if (!result.success) throw new ApiError("BAD_REQUEST");
  return result.data;
}

export function parseQuery<T extends z.ZodRawShape>(url: URL, shape: T) {
  const query = new Map<string, string>();
  for (const [name, value] of url.searchParams) {
    if (!Object.hasOwn(shape, name) || query.has(name)) throw new ApiError("BAD_REQUEST");
    query.set(name, value);
  }
  const result = z.strictObject(shape).safeParse(Object.fromEntries(query));
  if (!result.success) throw new ApiError("BAD_REQUEST");
  return result.data;
}

export const uuid = z.uuid().transform((value) => value.toLowerCase());
export const userId = z.string().refine((value) => validSegment(value) && [...value].length <= 128);
export const isoDateTime = z.iso.datetime({ offset: true }).transform((value, context) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    context.addIssue({ code: "custom", message: "日時が正しくありません。" });
    return z.NEVER;
  }
  return date.toISOString();
});
export const expectedVersion = z.number().int().min(1);
export const confirmed = z.literal(true);
const storableText = z.string().refine((value) => value.isWellFormed() && !value.includes("\0"));
export const title = storableText.trim().refine((value) => value.length > 0 &&
  [...value].length <= 100 && !/[\r\n\u2028\u2029]/.test(value));

function bodyText(maxLength: number) {
  return storableText.transform((value) => value.replace(/\r\n?/g, "\n"))
    .refine((value) => value.trim().length > 0 && [...value].length <= maxLength);
}

export const longText = bodyText(10_000);
export const shortText = bodyText(2_000);
