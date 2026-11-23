import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api/response";
import type { Viewer } from "../../src/auth/access";

vi.mock("server-only", () => ({}));
vi.mock("../../src/auth/server", () => ({ getAuthSession: vi.fn() }));

const { hasAdminScope, requireAdmin, scopeForTarget } = await import("../../src/auth/admin");

function viewer(roles: Viewer["roles"], profileState: Viewer["profileState"] = "public"): Viewer {
  return { userId: "u1", baseRole: "staff", isGraduating: false, profileState, userVersion: 1, roles };
}

const general = { schoolManager: false, appManager: false };
const app = { schoolManager: false, appManager: true };
const school = { schoolManager: true, appManager: false };

describe("管理権限の区分", () => {
  it.each([
    ["学校管理者", viewer(school), true, true],
    ["プロフィール非表示中の学校管理者（学校管理者のプロフィール管理はPoC対象外）", viewer(school, "hidden"), true, true],
    ["プロフィール公開中のアプリ管理者", viewer(app), true, false],
    ["プロフィール非表示中のアプリ管理者", viewer(app, "hidden"), false, false],
    ["一般利用者", viewer(general), false, false],
    ["プロフィール非表示中の一般利用者", viewer(general, "hidden"), false, false],
  ])("%s：両管理者の操作=%s、学校専用の操作=%s", (_label, subject, any, schoolOnly) => {
    expect(hasAdminScope(subject, "any")).toBe(any);
    expect(hasAdminScope(subject, "school")).toBe(schoolOnly);
  });

  it("資格不足は 403 FORBIDDEN を投げる", () => {
    expect(() => requireAdmin(viewer(general), "any")).toThrow(ApiError);
    try {
      requireAdmin(viewer(app), "school");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("FORBIDDEN");
    }
    expect(() => requireAdmin(viewer(app), "any")).not.toThrow();
    expect(() => requireAdmin(viewer(school), "school")).not.toThrow();
  });
});

describe("対象者によって学校専用になる操作", () => {
  it.each([
    ["アプリ管理者", app, "school"],
    ["学校管理者とアプリ管理者を兼ねる利用者", { schoolManager: true, appManager: true }, "school"],
    ["学校管理者（対象にできるかは各機能で判定）", school, "any"],
    ["一般利用者", general, "any"],
  ] as const)("対象者が%sなら %s", (_label, target, expected) => {
    expect(scopeForTarget(target)).toBe(expected);
  });
});
