export default function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[calc(100vh-56px)] items-center justify-center px-4 py-10">
      <div className="card w-full max-w-md">
        <h1 className="text-2xl font-bold">{title}</h1>
        <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}
