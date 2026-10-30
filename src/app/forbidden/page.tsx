import Link from "next/link";
import { ShieldOff } from "lucide-react";
import { EmptyState } from "@/components/ui/page";

export default function Forbidden() {
  return (
    <main className="mx-auto max-w-xl px-4 py-24">
      <EmptyState icon={ShieldOff} title="You don't have access to this" body="Your role in this organisation doesn't include this action. Ask an Admin if you need it." action={<Link className="btn btn-secondary" href="/overview">Back to overview</Link>} />
    </main>
  );
}
