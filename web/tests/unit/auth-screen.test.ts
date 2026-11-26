import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api/response";
import type { RequestAccess, Viewer } from "../../src/auth/access";

const mocks = vi.hoisted(() => ({
  resolveRequestAccess: vi.fn<(headers: Headers) => Promise<RequestAccess>>(),
  redirect: vi.fn((path: string): never => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { path });
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ Cookie: "session=1" }) }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("../../src/auth/access", () => ({ resolveRequestAccess: mocks.resolveRequestAccess }));

const { requireScreenViewer } = await import("../../src/auth/screen");

const session = { session: { expiresAt: new Date("2026-11-19T08:00:00.000Z") }, user: { id: "u1" } };
const viewer: Viewer = {
  userId: "u1", baseRole: "student", isGraduating: false, profileState: "public", userVersion: 1,
  roles: { schoolManager: false, appManager: false },
};

async function redirectedTo(path: string) {
  try {
    await requireScreenViewer(path);
  } catch (error) {
    if (error instanceof Error && "path" in error) return error.path;
    throw error;
  }
  return null;
}

beforeEach(() => {
  mocks.resolveRequestAccess.mockReset();
});

describe("ログイン後の画面の入口", () => {
  it("利用中は最新の Viewer を返す", async () => {
    mocks.resolveRequestAccess.mockResolvedValue({ session, state: { access: "active", viewer } });
    await expect(requireScreenViewer("/")).resolves.toEqual(viewer);
    expect(mocks.resolveRequestAccess.mock.calls[0][0].get("Cookie")).toBe("session=1");
  });

  it.each([
    ["/", "/login"],
    ["/?tab=home", "/login?returnTo=%2F%3Ftab%3Dhome"],
    ["/questions", "/login?returnTo=%2Fquestions"],
    ["/notices", "/login?returnTo=%2Fnotices"],
    ["//example.com/", "/login"],
  ])("未認証で %s を開くと、許可した戻り先だけを付けてログイン画面へ送る", async (path, expected) => {
    mocks.resolveRequestAccess.mockRejectedValue(new ApiError("AUTH_REQUIRED"));
    expect(await redirectedTo(path)).toBe(expected);
  });

  it("searchParams を戻り先のクエリーとして引き継ぐ", async () => {
    mocks.resolveRequestAccess.mockRejectedValue(new ApiError("AUTH_REQUIRED"));
    await expect(requireScreenViewer("/", { tab: "home", tag: ["a", "b"], empty: undefined }))
      .rejects.toMatchObject({ path: "/login?returnTo=%2F%3Ftab%3Dhome%26tag%3Da%26tag%3Db" });
  });

  it("発行・学校確認未完了はログイン画面の案内へ送る", async () => {
    mocks.resolveRequestAccess.mockRejectedValue(new ApiError("ACCOUNT_NOT_READY"));
    expect(await redirectedTo("/")).toBe("/login");
  });

  it("停止中はログイン画面の停止案内へ送り、Viewer を返さない", async () => {
    mocks.resolveRequestAccess.mockResolvedValue({ session, state: { access: "suspended", userId: "u1" } });
    expect(await redirectedTo("/?tab=home")).toBe("/login");
  });

  it("DB障害などの想定外の失敗はログイン画面へ送らず、元の例外の内容を含まない失敗にする", async () => {
    mocks.resolveRequestAccess.mockRejectedValue(new Error("db down"));
    await expect(requireScreenViewer("/")).rejects.toMatchObject({
      name: "ScreenReadError", message: expect.not.stringContaining("db down"),
    });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
