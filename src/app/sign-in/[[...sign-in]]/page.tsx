import { redirect } from "next/navigation";
import { Wordmark } from "@/components/brand";
import { env, isConfigured } from "@/env";
import { devSignIn } from "@/app/actions/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function SignInPage() {
  if (!isConfigured("auth")) redirect("/setup");
  const e = env();
  let body: React.ReactNode;
  if (e.AUTH_PROVIDER === "clerk") {
    const { SignIn } = await import("@clerk/nextjs");
    body = <SignIn routing="path" path="/sign-in" forceRedirectUrl="/overview" />;
  } else {
    body = (
      <form action={devSignIn} className="card w-full max-w-sm space-y-4 p-6">
        <div role="note" className="rounded-md border border-warn/40 bg-warn/10 p-3 text-xs text-warn">
          Local development sign-in. No password is checked. This provider is refused in production.
        </div>
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" name="email" type="email" required autoComplete="email" className="input" />
        </div>
        <div>
          <label className="label" htmlFor="name">Name (optional)</label>
          <input id="name" name="name" className="input" />
        </div>
        <button className="btn btn-primary w-full justify-center">Sign in</button>
      </form>
    );
  }
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 px-4">
      <Wordmark />
      {body}
    </main>
  );
}
