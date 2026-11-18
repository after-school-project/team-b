import { validateMutationRequest, type MutationRequest } from "./request";
import { ApiError, createApiResponse, type PageInfo, type SuccessStatus } from "./response";

type Method = "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" | "DELETE" | "PATCH";
type HandlerResult = { data: unknown; status?: SuccessStatus; page?: PageInfo; replayed?: true };
type Handler<Context, Extra extends unknown[] = []> =
  (request: Request, context: Context, ...extra: Extra) => HandlerResult | Promise<HandlerResult>;
type Handlers<Context> = Partial<{
  GET: Handler<Context>;
  POST: Handler<Context, [MutationRequest]>;
  PATCH: Handler<Context, [MutationRequest]>;
}>;

export function defineApiRoute<Context = unknown>(
  handlers: Handlers<Context>,
  environment?: Parameters<typeof validateMutationRequest>[2],
) {
  const allow = (["GET", "POST", "PATCH"] as const).filter((method) => handlers[method]).join(", ");

  function wrap(method: Method) {
    return async (request: Request, context: Context) => {
      const response = createApiResponse();
      try {
        let result: HandlerResult;
        if (method === "GET" && handlers.GET) {
          result = await handlers.GET(request, context);
        } else if ((method === "POST" || method === "PATCH") && handlers[method]) {
          const input = validateMutationRequest(request, method, environment);
          result = await handlers[method](request, context, input);
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

  // Export all seven in route.ts to override Next.js's implicit HEAD, OPTIONS and 405 handlers.
  return {
    GET: wrap("GET"), HEAD: wrap("HEAD"), OPTIONS: wrap("OPTIONS"), POST: wrap("POST"),
    PUT: wrap("PUT"), DELETE: wrap("DELETE"), PATCH: wrap("PATCH"),
  };
}
