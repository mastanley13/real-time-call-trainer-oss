import type { LucideIcon } from "lucide-react";

export default function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  as = "h2",
  tone = "default",
}: {
  icon: LucideIcon;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  as?: "h1" | "h2" | "h3";
  tone?: "default" | "alert";
}) {
  const Heading = as;
  const lampClass = tone === "alert" ? "lamp-alert" : "lamp-off";
  const iconClass = tone === "alert" ? "text-alert" : "text-ink-muted";
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <span className="relative flex h-12 w-12 items-center justify-center rounded-full border border-line bg-sunken">
        <Icon size={20} strokeWidth={1.75} className={iconClass} aria-hidden />
        <span className={`lamp ${lampClass} absolute -bottom-0.5 -right-0.5 !h-2.5 !w-2.5 ring-2 ring-surface`} aria-hidden />
      </span>
      <Heading className="mt-4 font-heading text-base font-bold text-ink">{title}</Heading>
      {children && <div className="mt-1.5 max-w-sm text-sm text-ink-soft">{children}</div>}
      {action && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
