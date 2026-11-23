/**
 * マイプロフィールの保存（PATCH /api/v1/me/profile）の応答を、画面の次の動作に変換する。
 * 画面（クライアント）から使うため、DBやサーバー専用の処理を読み込まない。
 */

export type SavedFieldError = "displayName" | "bio" | "occupation" | "interests";

export type SaveOutcome =
  /** 保存が確定し、新しい版番号と公開状態を確認できた。 */
  | { kind: "saved"; version: number; state: "public" | "hidden" }
  /**
   * 保存されたか確認できない（サーバーエラー、通信の途中切断、200 でも本文を読めない）。
   * 同じ内容なら同じ再送キーで送り直し、確定済みの結果を受け取る。別のキーで送ると、版番号が古いまま 409 になる。
   */
  | { kind: "unconfirmed" }
  | { kind: "conflict" }
  | { kind: "invalid"; fields: SavedFieldError[] }
  | { kind: "unauthorized" }
  | { kind: "failed" };

const fieldNames: readonly SavedFieldError[] = ["bio", "occupation", "interests"];

function savedResult(body: unknown): { version: number; state: "public" | "hidden" } | null {
  const data = (body as { data?: { version?: unknown; state?: unknown } } | null)?.data;
  if (!data || typeof data.version !== "number" || !Number.isInteger(data.version) || data.version < 1) return null;
  if (data.state !== "public" && data.state !== "hidden") return null;
  return { version: data.version, state: data.state };
}

function invalidFields(body: unknown): SavedFieldError[] {
  const fields = (body as { error?: { fields?: Array<{ path?: unknown }> } } | null)?.error?.fields;
  const found = new Set<SavedFieldError>();
  for (const { path } of Array.isArray(fields) ? fields : []) {
    if (typeof path !== "string") continue;
    if (path === "displayName") found.add("displayName");
    for (const field of fieldNames) if (path.startsWith(`optionalFields.${field}`)) found.add(field);
  }
  return [...found];
}

/**
 * 応答の状態コードと本文（読み取れなければ null）から、次の動作を決める。
 * 200 でも、版番号と公開状態を本文から確認できるまでは保存済みとして扱わない。
 */
export function saveOutcome(status: number, body: unknown): SaveOutcome {
  if (status >= 200 && status < 300) {
    const saved = savedResult(body);
    return saved ? { kind: "saved", ...saved } : { kind: "unconfirmed" };
  }
  if (status >= 500) return { kind: "unconfirmed" };
  if (status === 409) return { kind: "conflict" };
  if (status === 422) return { kind: "invalid", fields: invalidFields(body) };
  if (status === 401 || status === 403) return { kind: "unauthorized" };
  return { kind: "failed" };
}
