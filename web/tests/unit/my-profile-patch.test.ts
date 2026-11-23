import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/response";
import { profilePatchSchema, requireProfileChanges, type ProfilePatch } from "../../src/profile/my-profile";

/** API設計書 §3・§6 ProfilePatch の入力検証（#8 ①、AC-01）。 */
describe("ProfilePatch の入力検証", () => {
  const parse = (body: unknown) => profilePatchSchema.safeParse(body);

  it("公開表示名は前後の空白を除いて1〜50文字（コードポイント）で、改行を含めない", () => {
    expect(parse({ expectedVersion: 1, displayName: "  あおい  " })).toMatchObject({ success: true, data: { displayName: "あおい" } });
    expect(parse({ expectedVersion: 1, displayName: "𠮷".repeat(50) }).success).toBe(true);
    expect(parse({ expectedVersion: 1, displayName: "𠮷".repeat(51) }).success).toBe(false);
    expect(parse({ expectedVersion: 1, displayName: "   " }).success).toBe(false);
    expect(parse({ expectedVersion: 1, displayName: "一行目\n二行目" }).success).toBe(false);
    expect(parse({ expectedVersion: 1, displayName: "NUL\0" }).success).toBe(false);
  });

  it("任意項目は項目ごとの上限まで受け付け、空文字列（値の消去）を許可し、改行をLFにそろえる", () => {
    expect(parse({ expectedVersion: 1, optionalFields: { bio: { value: "あ".repeat(1000) } } }).success).toBe(true);
    expect(parse({ expectedVersion: 1, optionalFields: { bio: { value: "あ".repeat(1001) } } }).success).toBe(false);
    expect(parse({ expectedVersion: 1, optionalFields: { occupation: { value: "あ".repeat(101) } } }).success).toBe(false);
    expect(parse({ expectedVersion: 1, optionalFields: { interests: { value: "あ".repeat(201) } } }).success).toBe(false);
    expect(parse({ expectedVersion: 1, optionalFields: { bio: { value: "" } } }).success).toBe(true);
    expect(parse({ expectedVersion: 1, optionalFields: { bio: { value: "一行目\r\n二行目" } } }))
      .toMatchObject({ success: true, data: { optionalFields: { bio: { value: "一行目\n二行目" } } } });
  });

  it("値の null・未定義の公開範囲・未定義の項目を拒否する", () => {
    expect(parse({ expectedVersion: 1, optionalFields: { bio: { value: null } } }).success).toBe(false);
    expect(parse({ expectedVersion: 1, optionalFields: { bio: { visibility: "public" } } }).success).toBe(false);
    expect(parse({ expectedVersion: 1, optionalFields: { hobby: { value: "読書" } } }).success).toBe(false);
    for (const field of ["department", "entryYear", "graduationYear", "baseRole", "schoolManager", "appManager", "privateRealName"]) {
      expect(parse({ expectedVersion: 1, [field]: "x" }).success, field).toBe(false);
    }
  });

  it("版番号は1以上の整数が必須", () => {
    expect(parse({ displayName: "あおい" }).success).toBe(false);
    expect(parse({ expectedVersion: 0, displayName: "あおい" }).success).toBe(false);
    expect(parse({ expectedVersion: "1", displayName: "あおい" }).success).toBe(false);
  });

  it("変更する項目が1つもなければ 422 にする", () => {
    const rejects = (patch: ProfilePatch) => {
      try {
        requireProfileChanges(patch);
      } catch (error) {
        return error instanceof ApiError && error.code === "VALIDATION_FAILED";
      }
      return false;
    };
    expect(rejects({ expectedVersion: 1 })).toBe(true);
    expect(rejects({ expectedVersion: 1, optionalFields: {} })).toBe(true);
    expect(rejects({ expectedVersion: 1, optionalFields: { bio: {} } })).toBe(true);
    expect(rejects({ expectedVersion: 1, searchOptIn: false })).toBe(false);
    expect(rejects({ expectedVersion: 1, optionalFields: { bio: { visibility: "self" } } })).toBe(false);
  });
});
