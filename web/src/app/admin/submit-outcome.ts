/**
 * 管理操作（POST /api/v1/admin/*）の応答を、画面の次の動作に変換する。
 * 画面（クライアント）から使うため、DBやサーバー専用の処理を読み込まない。
 */

export type SubmitOutcome<State extends string> =
  /** 操作が確定し、結果の状態を確認できた。 */
  | { kind: "done"; state: State }
  /**
   * 確定したか確認できない（サーバーエラー、通信の途中切断、200 でも本文を読めない）。
   * 同じ内容なら同じ再送キーで送り直し、確定済みの結果を受け取る。
   */
  | { kind: "unconfirmed" }
  /** 対象が更新されたか、処理済み。 */
  | { kind: "conflict" }
  | { kind: "invalid" }
  | { kind: "unauthenticated" }
  /** 権限がないか、対象を閲覧できない。 */
  | { kind: "denied" }
  | { kind: "failed" };

/** 応答の状態コードと本文（読み取れなければ null）から、次の動作を決める。200 でも結果の状態を確認できるまで確定とみなさない。 */
export function submitOutcome<State extends string>(
  status: number, body: unknown, states: readonly State[],
): SubmitOutcome<State> {
  if (status >= 200 && status < 300) {
    const value = (body as { data?: { state?: unknown } } | null)?.data?.state;
    const state = states.find((candidate) => candidate === value);
    return state === undefined ? { kind: "unconfirmed" } : { kind: "done", state };
  }
  if (status >= 500) return { kind: "unconfirmed" };
  if (status === 409) return { kind: "conflict" };
  if (status === 422) return { kind: "invalid" };
  if (status === 401) return { kind: "unauthenticated" };
  if (status === 403 || status === 404) return { kind: "denied" };
  return { kind: "failed" };
}

/** 確定しなかった場合の案内。`reload` は、最新の内容を読み込む操作を示すか。 */
export function outcomeMessage(
  kind: Exclude<SubmitOutcome<string>["kind"], "done">, action: string,
): { message: string; reload: boolean } {
  switch (kind) {
    case "unconfirmed":
      return {
        message: `${action}の結果を確認できませんでした。内容を変えずにもう一度操作すると、同じ操作として確認します。`,
        reload: false,
      };
    case "conflict":
      return { message: "内容が更新されています。最新の内容を確認してください。", reload: true };
    case "invalid":
      return { message: "入力内容を確認してください。", reload: false };
    case "unauthenticated":
      return { message: "ログイン状態を確認できませんでした。再読み込みしてください。", reload: true };
    case "denied":
      return { message: "この操作を行う権限がないか、対象を表示できなくなりました。再読み込みしてください。", reload: true };
    case "failed":
      return { message: `${action}を実行できませんでした。時間をおいてもう一度お試しください。`, reload: false };
  }
}
