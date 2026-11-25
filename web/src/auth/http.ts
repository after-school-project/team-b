import { toNextJsHandler } from "better-auth/next-js";
import { z } from "zod";
import { describeFailure } from "@/api/safe-failure";
import { collectAuthFailure } from "./failure";
import { getAuthServer, getAuthSession } from "./server";
import { authOrigin } from "./web-config";

const user = z.object({ id: z.string() });
const signIn = z.object({ redirect: z.literal(false), user });
const getSession = z.object({ session: z.object({ expiresAt: z.string() }), user }).nullable();
const signOut = z.object({ success: z.literal(true) });
const publicRoutes = new Map<string, z.ZodType>([
  ["POST /api/auth/sign-in/username", signIn],
  ["GET /api/auth/get-session", getSession],
  ["POST /api/auth/sign-out", signOut],
]);

function errorResponse(status: number, code: string, headers = new Headers()) {
  headers.set("Cache-Control", "no-store");
  return Response.json({ code }, { status, headers });
}

export async function handleAuthRequest(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const responseSchema = publicRoutes.get(request.method + " " + path);

  if (!responseSchema) return errorResponse(404, "NOT_FOUND");

  return collectAuthFailure(async (failure) => {
    const response = await respond(request, path, responseSchema, failure);
    if (response.status >= 500) {
      // path は公開する経路（publicRoutes）のどれか。入力値・SQL・引数は出さない。
      console.error("認証APIの処理に失敗しました。", { path, status: response.status, ...describeFailure(failure.error) });
    }
    return response;
  });
}

async function respond(
  request: Request, path: string, responseSchema: z.ZodType, failure: { error?: unknown },
): Promise<Response> {
  try {
    if (request.method === "POST" && request.headers.get("Origin") !== authOrigin()) {
      return errorResponse(403, "ORIGIN_NOT_ALLOWED");
    }

    const auth = await getAuthServer();
    const handlers = toNextJsHandler(auth);
    const response = await (request.method === "GET" ? handlers.GET : handlers.POST)(request);
    const headers = new Headers({ "Cache-Control": "no-store" });

    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After") ?? response.headers.get("X-Retry-After");
      if (retryAfter) headers.set("Retry-After", retryAfter);
      return errorResponse(429, "RATE_LIMITED", headers);
    }
    if (response.status === 401) return errorResponse(401, "INVALID_USERNAME_OR_PASSWORD");
    if (!response.ok) return errorResponse(response.status, "AUTH_REQUEST_FAILED");

    const body = responseSchema.parse(await response.json());
    // Better Auth's sign-out can return success even when its DB deletion fails.
    if (path === "/api/auth/sign-out" && await getAuthSession(request.headers)) {
      return errorResponse(503, "AUTH_REQUEST_FAILED");
    }
    for (const cookie of response.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
    return Response.json(body, { headers });
  } catch (error) {
    failure.error = error;
    return errorResponse(500, "AUTH_REQUEST_FAILED");
  }
}
