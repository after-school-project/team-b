import { handleAuthRequest } from "@/auth/http";

export const runtime = "nodejs";

export const GET = handleAuthRequest;
export const POST = handleAuthRequest;
