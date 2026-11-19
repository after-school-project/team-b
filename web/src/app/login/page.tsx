import LoginForm from "./login-form";
import { resolveReturnTo } from "./return-to";

type LoginPageProps = {
  searchParams: Promise<{ returnTo?: string | string[] }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const returnTo = Array.isArray(params.returnTo) ? "/" : resolveReturnTo(params.returnTo);

  return <LoginForm returnTo={returnTo} />;
}
