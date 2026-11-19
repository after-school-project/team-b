import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api/response";
import {
  canEnterAdmin, canWriteContent, requireActive, requireProfileWritable, toMeState, type Viewer,
} from "../../src/auth/access";

vi.mock("server-only", () => ({}));
vi.mock("../../src/auth/server", () => ({ getAuthSession: vi.fn() }));

const session = { session: { expiresAt: new Date("2026-11-19T08:00:00.000Z") }, user: { id: "u1" } };

function viewer(overrides: Partial<Viewer> = {}, roles: Partial<Viewer["roles"]> = {}): Viewer {
  return {
    userId: "u1", baseRole: "student", isGraduating: false, profileState: "public", userVersion: 3,
    ...overrides,
    roles: { schoolManager: false, appManager: false, ...roles },
  };
}

function code(action: () => unknown) {
  try {
    action();
  } catch (error) {
    if (error instanceof ApiError) return error.code;
    throw error;
  }
  return null;
}

describe("管理エリアの入口", () => {
  it.each([
    ["一般利用者", viewer(), false],
    ["学校管理者", viewer({ baseRole: "staff" }, { schoolManager: true }), true],
    ["プロフィール非表示中の学校管理者", viewer({ baseRole: "staff", profileState: "hidden" }, { schoolManager: true }), true],
    ["アプリ管理者", viewer({}, { appManager: true }), true],
    ["プロフィール非表示中のアプリ管理者", viewer({ profileState: "hidden" }, { appManager: true }), false],
  ])("%s", (_label, target, expected) => {
    expect(canEnterAdmin(target)).toBe(expected);
  });
});

describe("利用状態による拒否", () => {
  it("停止中を ACCOUNT_SUSPENDED で拒否する", () => {
    expect(code(() => requireActive({ access: "suspended", userId: "u1" })))
      .toBe("ACCOUNT_SUSPENDED");
    expect(requireActive({ access: "active", viewer: viewer() })).toEqual(viewer());
  });

  it("プロフィール非表示中の書き込みを PROFILE_WRITE_RESTRICTED で拒否する", () => {
    expect(canWriteContent(viewer({ profileState: "hidden" }))).toBe(false);
    expect(code(() => requireProfileWritable(viewer({ profileState: "hidden" })))).toBe("PROFILE_WRITE_RESTRICTED");
    expect(code(() => requireProfileWritable(viewer()))).toBeNull();
  });
});

describe("MeState への投影", () => {
  it("利用中は設計書の項目だけを返す", () => {
    expect(toMeState({ session, state: { access: "active", viewer: viewer({}, { appManager: true }) } })).toEqual({
      access: "active",
      userId: "u1",
      baseRole: "student",
      isGraduating: false,
      profileState: "public",
      userVersion: 3,
      roles: { schoolManager: false, appManager: true },
      capabilities: { canEnterAdmin: true, canWriteContent: true },
      sessionExpiresAt: "2026-11-19T08:00:00.000Z",
    });
  });

  it("停止中は本人向け理由だけを返す", () => {
    expect(toMeState({ session, state: { access: "suspended", userId: "u1" } }, "規約違反のため"))
      .toStrictEqual({ access: "suspended", publicReason: "規約違反のため" });
  });

  it("停止中に本人向け理由がなければ推測で補わない", () => {
    expect(() => toMeState({ session, state: { access: "suspended", userId: "u1" } })).toThrow();
  });
});
