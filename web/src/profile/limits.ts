/**
 * マイプロフィールの入力の上限（API設計書 §3）。サーバーの入力検証と画面の入力欄で共有する。
 * 画面（クライアント）からも読み込むため、DBやサーバー専用の処理をこのファイルに置かない。
 */

/** 公開表示名の最大文字数（前後空白除去後）。 */
export const displayNameMaxLength = 50;

/** 任意項目ごとの最大文字数（OptionalProfileField）。 */
export const optionalFieldLimits = { bio: 1000, occupation: 100, interests: 200 } as const;

/** 文字数はUnicodeのコードポイントで数える（API設計書 §3）。 */
export function countCharacters(value: string): number {
  return [...value].length;
}
