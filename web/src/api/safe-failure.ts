/**
 * 想定外の失敗を、サーバーログに出してよい情報だけで表す。
 *
 * 例外のメッセージ・SQL・引数（セッショントークンや入力値）・接続文字列は含めない。画面・業務API・認証APIで共通に使う。
 */
export type FailureDescription = {
  /** SQLSTATE・接続エラーのコード、なければ例外の種類名。 */
  cause: string;
  /** 呼び出し元（スタックのうち、メッセージを除いた行）。 */
  at: string[];
};

export function describeFailure(reason: unknown): FailureDescription {
  return { cause: failureCode(reason), at: errorChain(reason).map(stackFrames).find((found) => found.length > 0) ?? [] };
}

/** 例外と、その cause。Drizzle は PostgreSQL の例外を、Better Auth は Drizzle の例外を cause に持つ。 */
function errorChain(reason: unknown): Error[] {
  const chain: Error[] = [];
  for (let error = reason; error instanceof Error && !chain.includes(error); error = error.cause) chain.push(error);
  return chain;
}

function failureCode(reason: unknown): string {
  for (const error of errorChain(reason)) {
    const code = "code" in error ? error.code : undefined;
    if (typeof code === "string" && /^(?:[0-9A-Z]{5}|E[A-Z_]{2,30})$/.test(code)) return code;
  }
  return reason instanceof Error && /^[A-Za-z]{1,40}$/.test(reason.name) ? reason.name : "UNKNOWN";
}

/** 例外のスタックから、メッセージ（SQL・引数を含み得る）を除いた呼び出し元の行だけを取り出す。 */
function stackFrames(error: Error): string[] {
  if (typeof error.stack !== "string") return [];
  const start = error.stack.indexOf(error.message);
  // メッセージの範囲が分からなければ、呼び出し元の行と区別できないため何も残さない。
  if (error.message === "" || start < 0) return [];
  return error.stack.slice(start + error.message.length).split("\n")
    .filter((line) => /^\s+at /.test(line)).map((line) => line.trim());
}
