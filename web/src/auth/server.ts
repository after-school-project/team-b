import "server-only";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { z } from "zod";
import * as schema from "@/db/auth-schema";
import { authOptions } from "./options";
import { authWebOptions } from "./web-config";

/**
 * Login attempts allowed per client IP. School NATs put about 300 students and alumni on one IP,
 * so the limit lets all of them sign in within one minute. Issued passwords are 144-bit random
 * values, so a higher limit does not make online guessing practical.
 */
export const loginRateLimit = { window: 60, max: 300 } as const;

const loginBody = z.strictObject({
  username: z.string().regex(/^[a-z0-9_]{3,30}$/),
  password: z.string().min(12).max(128),
});

async function createAuthServer() {
  const webOptions = authWebOptions();
  const { db } = await import("@/db/client");
  const options = authOptions(drizzleAdapter(db, { provider: "pg", schema }));

  return betterAuth({
    ...options,
    ...webOptions,
    rateLimit: {
      ...options.rateLimit,
      customRules: {
        "/sign-in/username": loginRateLimit,
      },
    },
    // SDK database errors may contain SQL parameters with authentication secrets.
    logger: { disabled: true },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (context.path === "/sign-in/username" && !loginBody.safeParse(context.body).success) {
          throw new APIError("BAD_REQUEST");
        }
      }),
    },
  });
}

let authServer: ReturnType<typeof createAuthServer> | undefined;

export async function getAuthServer() {
  authServer ??= createAuthServer().catch((error: unknown) => {
    authServer = undefined;
    throw error;
  });
  return authServer;
}

export type AuthSession = {
  session: { expiresAt: Date };
  user: { id: string };
};

/** Returns the current DB-backed authentication session for the incoming request. */
export async function getAuthSession(headers: Headers): Promise<AuthSession | null> {
  const auth = await getAuthServer();
  const result = await auth.api.getSession({ headers });
  if (!result) return null;
  return {
    session: { expiresAt: result.session.expiresAt },
    user: { id: result.user.id },
  };
}
