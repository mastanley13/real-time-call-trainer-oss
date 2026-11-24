export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden />;
}

/** Full-page dashboard/logbook placeholder used while auth/session data loads. */
export function PageSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="page space-y-6" role="status">
      <Skeleton className="h-9 w-64" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-24" />)}
      </div>
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-16" />)}
      <span className="sr-only">Loading...</span>
    </div>
  );
}

/** Library-shaped placeholder: search bar, filter rail, and 3-column persona strip grid. */
export function LibrarySkeleton() {
  return (
    <div className="page space-y-6" role="status">
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <Skeleton className="h-10 w-44" />
      </div>
      <Skeleton className="h-11 w-full" />
      <div className="grid gap-8 lg:grid-cols-[230px_minmax(0,1fr)]">
        <div className="hidden space-y-4 lg:block">
          <Skeleton className="h-5 w-24" />
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-7 w-full" />)}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-44" />)}
        </div>
      </div>
      <span className="sr-only">Loading personas...</span>
    </div>
  );
}

/** Pre-flight briefing placeholder: briefing column left, cockpit panel right. */
export function BriefingSkeleton() {
  return (
    <div className="page space-y-6" role="status">
      <Skeleton className="h-5 w-24" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
        <Skeleton className="h-[460px] w-full" />
      </div>
      <span className="sr-only">Loading briefing...</span>
    </div>
  );
}

/** Debrief placeholder inside the dark deck scope: score ring left, analysis center, transcript right. */
export function DebriefSkeleton() {
  return (
    <div className="page space-y-6" role="status">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-9 w-72 max-w-full" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-10 w-28" />
          <Skeleton className="h-10 w-36" />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)_380px]">
        <Skeleton className="h-80 w-full" />
        <div className="space-y-4">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
        <Skeleton className="hidden h-96 w-full xl:block" />
      </div>
      <span className="sr-only">Loading debrief...</span>
    </div>
  );
}

/** Form-shaped placeholder for wizard, scenario editor, and settings pages. */
export function FormSkeleton({ sidebar = true }: { sidebar?: boolean }) {
  return (
    <div className="page space-y-6" role="status">
      <Skeleton className="h-8 w-52" />
      <div className={sidebar ? "grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]" : "max-w-3xl space-y-5"}>
        {sidebar && (
          <div className="space-y-2">
            {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        )}
        <div className="space-y-4">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
      <span className="sr-only">Loading form...</span>
    </div>
  );
}
