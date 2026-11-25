import { z } from "zod";

/** 一覧の検索条件の共通の検証（API設計書 §3 一覧のクエリー）。 */

/** キーワード・学科。前後空白を除いた1〜100文字（コードポイント）。 */
export const searchText = z.string().transform((value) => value.trim())
  .refine((value) => value.length > 0 && [...value].length <= 100 && value.isWellFormed() && !value.includes("\0"));

/** 年度。4桁の整数。 */
export const fourDigitYear = z.string().regex(/^\d{4}$/).transform(Number);

/** 部分一致の LIKE パターン。特殊文字をそのままの文字として扱う（PostgreSQL の既定のエスケープ文字は `\`）。 */
export function containing(value: string): string {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}
