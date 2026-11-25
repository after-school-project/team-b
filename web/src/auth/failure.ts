import { AsyncLocalStorage } from "node:async_hooks";

type AuthFailure = { error?: unknown };

const current = new AsyncLocalStorage<AuthFailure>();

/** 認証APIの1つの要求を処理し、その間に Better Auth が記録した例外を `failure.error` に受け取る。 */
export function collectAuthFailure<T>(run: (failure: AuthFailure) => Promise<T>): Promise<T> {
  const failure: AuthFailure = {};
  return current.run(failure, () => run(failure));
}

/**
 * Better Auth の logger の出力先。DBの例外は SQL と引数（セッショントークンなど）を含むため印字せず、
 * 内部で処理されて応答に現れない例外だけを、認証APIの入口が安全な形で記録できるように渡す。
 */
export function receiveAuthLog(_level: string, _message: string, ...details: unknown[]): void {
  const failure = current.getStore();
  const error = details.find((detail) => detail instanceof Error);
  if (failure && error) failure.error ??= error;
}
