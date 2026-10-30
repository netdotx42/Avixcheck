import { redirect } from "next/navigation";
import { Wordmark } from "@/components/brand";
import { getSessionUser } from "@/lib/auth/session";
import { listUserOrgs } from "@/lib/auth/context";
import { createOrgAction } from "@/app/actions/orgs";
import { env, isConfigured } from "@/env";

export const dynamic = "force-dynamic";
export const metadata = { title: "Create organisation" };

export default async function Onboarding() {
  if (!isConfigured("database") || !isConfigured("auth")) redirect("/setup");
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  const orgs = await listUserOrgs(user.id);
  const allowDemo = env().APP_ENV !== "production";
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 px-4">
      <Wordmark />
      <form action={createOrgAction} className="card space-y-4 p-6">
        <div>
          <h1 className="text-lg font-semibold">Create your organisation</h1>
          <p className="mt-1 text-sm text-muted">You&apos;ll be its first Admin. Joining an existing one? Open the invitation link you were sent.</p>
        </div>
        <div>
          <label className="label" htmlFor="name">Organisation name</label>
          <input id="name" name="name" required minLength={2} maxLength={120} className="input" />
        </div>
        <div>
          <label className="label" htmlFor="baseCurrency">Base currency</label>
          <input id="baseCurrency" name="baseCurrency" defaultValue="GBP" pattern="[A-Za-z]{3}" maxLength={3} className="input uppercase" />
        </div>
        {allowDemo && (
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" name="isDemo" /> Demo organisation (synthetic data, kept separate from production)
          </label>
        )}
        <button className="btn btn-primary w-full justify-center">Create organisation</button>
        {orgs.length > 0 && <a href="/overview" className="block text-center text-sm text-muted underline">Back to my organisations</a>}
      </form>
    </main>
  );
}
