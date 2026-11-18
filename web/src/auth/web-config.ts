import type { BetterAuthOptions } from "better-auth";

type Environment = Readonly<Record<string, string | undefined>>;
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function authOrigin(environment: Environment = process.env): string {
  const configured = environment.BETTER_AUTH_URL;
  const url = URL.parse(configured ?? "");
  // A path, query, credentials, or wildcard is invalid even if URL.origin would strip it.
  const localHttp = url?.protocol === "http:" && loopbackHosts.has(url.hostname) &&
    !environment.VERCEL && !environment.VERCEL_ENV &&
    (environment.NODE_ENV === "development" || environment.NODE_ENV === "test");
  if (!url || (configured !== url.origin && configured !== url.origin + "/") ||
    url.hostname.includes("*") || (url.protocol !== "https:" && !localHttp)) {
    throw new Error("BETTER_AUTH_URL に環境の正規オリジンを設定してください。");
  }
  return url.origin;
}

// The HTTP authentication entry point uses these options along with authOptions().
export function authWebOptions(environment: Environment = process.env) {
  const origin = authOrigin(environment);
  return {
    baseURL: origin,
    trustedOrigins: [origin],
    advanced: {
      useSecureCookies: origin.startsWith("https:"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
    },
  } satisfies BetterAuthOptions;
}
