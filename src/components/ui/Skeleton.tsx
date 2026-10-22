export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden />;
}

/** Full-page placeholder used while auth/session data loads. */
export function PageSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="page space-y-6" role="status" aria-label="Loading">
      <Skeleton className="h-9 w-64" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-24" />)}
      </div>
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-16" />)}
      <span className="sr-only">Loading…</span>
    </div>
  );
}
