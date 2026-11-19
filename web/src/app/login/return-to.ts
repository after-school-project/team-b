const appOrigin = "https://after-school.invalid";
const implementedPaths = new Set(["/"]);

export function resolveReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/";
  }

  try {
    const destination = new URL(value, appOrigin);
    if (
      destination.origin !== appOrigin ||
      destination.pathname === "/login" ||
      destination.pathname.startsWith("/api/") ||
      !implementedPaths.has(destination.pathname)
    ) {
      return "/";
    }

    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return "/";
  }
}
