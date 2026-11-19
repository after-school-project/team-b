import type { Metadata } from "next";
import { resolveReturnTo } from "@/auth/return-to";
import LoginForm from "./login-form";

export const metadata: Metadata = {
  title: "ログイン | After School Project",
};

type LoginPageProps = {
  searchParams: Promise<{ returnTo?: string | string[] }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const returnTo = Array.isArray(params.returnTo) ? "/" : resolveReturnTo(params.returnTo);

  return <LoginForm returnTo={returnTo} />;
}
