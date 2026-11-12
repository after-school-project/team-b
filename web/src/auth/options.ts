import type { BetterAuthOptions } from "better-auth";
import { username } from "better-auth/plugins/username";

export function authOptions(database: BetterAuthOptions["database"]) {
  return {
    database,
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: false,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    plugins: [
      username({
        usernameValidator: (value) => /^[a-z0-9_]+$/.test(value),
        minUsernameLength: 3,
        maxUsernameLength: 30,
      }),
    ],
    rateLimit: { enabled: true, storage: "database" },
    session: {
      expiresIn: 8 * 60 * 60,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    telemetry: { enabled: false },
  } satisfies BetterAuthOptions;
}
