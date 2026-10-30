import { redirect } from "next/navigation";
import { Wordmark } from "@/components/brand";
import { getSessionUser } from "@/lib/auth/session";
import { acceptInvitationAction } from "@/app/actions/orgs";

export const dynamic = "force-dynamic";
export const metadata = { title: "Accept invitation" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await getSessionUser();
  if (!user) redirect(`/sign-in?redirect_url=${encodeURIComponent(`/invite/${token}`)}`);
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 px-4">
      <Wordmark />
      <form action={acceptInvitationAction} className="card space-y-4 p-6">
        <h1 className="text-lg font-semibold">Join organisation</h1>
        <p className="text-sm text-muted">You&apos;re signed in as <span className="text-text">{user.email}</span>. The invitation must have been sent to this address.</p>
        <input type="hidden" name="token" value={token} />
        <button className="btn btn-primary w-full justify-center">Accept invitation</button>
      </form>
    </main>
  );
}
