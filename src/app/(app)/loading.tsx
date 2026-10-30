import { TableSkeleton } from "@/components/ui/page";

export default function Loading() {
  return (
    <div>
      <div className="skeleton mb-6 h-8 w-64" />
      <TableSkeleton />
    </div>
  );
}
