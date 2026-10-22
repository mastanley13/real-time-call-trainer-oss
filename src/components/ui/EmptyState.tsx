import type { LucideIcon } from "lucide-react";

export default function EmptyState({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-soft text-primary"><Icon size={22} aria-hidden /></span>
      <h2 className="mt-4 font-heading text-base font-semibold">{title}</h2>
      <div className="mt-1 max-w-sm text-sm text-ink-soft">{children}</div>
    </div>
  );
}
