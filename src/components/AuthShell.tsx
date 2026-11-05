import BrandMark from "@/components/BrandMark";
import { brand } from "@/lib/tenant";

export default function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[calc(100vh-56px)] items-center justify-center bg-[radial-gradient(60%_50%_at_50%_0%,rgb(var(--primary)/0.14)_0%,transparent_70%)] px-4 py-10">
      <div className="card enter w-full max-w-md shadow-pop sm:p-8">
        <BrandMark size={40} labelled />
        <h1 className="mt-5 text-2xl font-bold">{title}</h1>
        <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>
        <div className="mt-6">{children}</div>
        {brand.disclaimer && <p className="mt-6 border-t border-line pt-4 text-xs text-ink-muted">{brand.disclaimer}</p>}
      </div>
    </div>
  );
}
