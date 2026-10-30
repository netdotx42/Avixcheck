import { TableSkeleton } from "@/components/ui/page";

export default function Loading() {
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <TableSkeleton rows={10} />
      <TableSkeleton rows={10} />
    </div>
  );
}
