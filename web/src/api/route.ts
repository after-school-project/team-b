import { validateMutationInput, validateMutationOrigin, type MutationRequest } from "./request";
import { ApiError, createApiResponse, type PageInfo, type SuccessStatus } from "./response";

type Method = "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" | "DELETE" | "PATCH";
export type HandlerResult = { data: unknown; status?: SuccessStatus; page?: PageInfo; replayed?: true };
type Environment = Parameters<typeof validateMutationOrigin>[1];
type Handler<Context, Extra extends unknown[] = []> =
  (request: Request, context: Context, ...extra: Extra) => HandlerResult | Promise<HandlerResult>;
type Handlers<Context> = Partial<{
  GET: Handler<Context>;
  POST: Handler<Context, [MutationRequest]>;
  PATCH: Handler<Context, [MutationRequest]>;
}>;
export type ActorHandlers<Context, Actor> = Partial<{
  GET: Handler<Context, [Actor]>;
  POST: Handler<Context, [Actor, MutationRequest]>;
  PATCH: Handler<Context, [Actor, MutationRequest]>;
}>;

/**
 * 処理の前に操作者を解決する Route Handler を定義する。
 * 更新では Origin を確認してから操作者を解決し、その後に Content-Type・再送キーなどの形式を確認する。
 * これにより、未認証・利用資格なしの更新は形式の誤りより先に 401・403 で拒否される。
 */
export function defineActorApiRoute<Context, Actor>(
  handlers: ActorHandlers<Context, Actor>,
  resolveActor: (request: Request) => Actor | Promise<Actor>,
  environment?: Environment,
) {
  const allow = (["GET", "POST", "PATCH"] as const).filter((method) => handlers[method]).join(", ");

  function wrap(method: Method) {
    return async (request: Request, context: Context) => {
      const response = createApiResponse();
      try {
        let result: HandlerResult;
        if (method === "GET" && handlers.GET) {
          result = await handlers.GET(request, context, await resolveActor(request));
        } else if ((method === "POST" || method === "PATCH") && handlers[method]) {
          validateMutationOrigin(request, environment);
          const actor = await resolveActor(request);
          const input = validateMutationInput(request, method);
          result = await handlers[method](request, context, actor, input);
        } else {
          throw new ApiError("METHOD_NOT_ALLOWED", { allow });
        }
        const { data, ...options } = result;
        return response.success(data, options);
      } catch (error) {
        return response.failure(error);
      }
    };
  }

  // Export all seven supported methods to override Next.js's implicit handlers.
  return {
    GET: wrap("GET"), HEAD: wrap("HEAD"), OPTIONS: wrap("OPTIONS"), POST: wrap("POST"),
    PUT: wrap("PUT"), DELETE: wrap("DELETE"), PATCH: wrap("PATCH"),
  };
}

export function defineApiRoute<Context = unknown>(handlers: Handlers<Context>, environment?: Environment) {
  const { GET, POST, PATCH } = handlers;
  return defineActorApiRoute<Context, undefined>({
    GET: GET && ((request, context) => GET(request, context)),
    POST: POST && ((request, context, _actor, input) => POST(request, context, input)),
    PATCH: PATCH && ((request, context, _actor, input) => PATCH(request, context, input)),
  }, () => undefined, environment);
}
