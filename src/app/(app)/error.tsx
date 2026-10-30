"use client";
import { ErrorState } from "@/components/ui/page";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorState
      body={`This page could not load. Your data has not been changed. ${error.digest ? `Reference: ${error.digest}` : ""}`}
      action={<button className="btn btn-primary" onClick={reset}>Try again</button>}
    />
  );
}
