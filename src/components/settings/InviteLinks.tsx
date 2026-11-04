"use client";

import { forwardRef, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

export interface IssuedLink { email: string; link: string }

/**
 * The links from the last invite or resend. They are shown once: the server keeps only a hash, so closing this
 * panel means a resend is the way to get a link again. Each link is in a read-only field (select it by focus or
 * tap) with a Copy button; the copied state is announced through one polite live region.
 */
const InviteLinks = forwardRef<HTMLDivElement, { links: IssuedLink[]; onDone: () => void }>(function InviteLinks({ links, onDone }, ref) {
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function copy(item: IssuedLink) {
    try {
      await navigator.clipboard.writeText(item.link);
      setFailed(false);
      setCopied(item.link);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 2000);
    } catch {
      setFailed(true);
    }
  }

  return (
    <section ref={ref} className="banner-ok space-y-3 p-4 sm:p-5" aria-labelledby="links-h">
      <div>
        <h2 id="links-h" className="font-bold">{links.length === 1 ? "Invite link ready" : `${links.length} invite links ready`}</h2>
        <p className="mt-1 text-ink-soft">Send each person their own link. It works once, for that email address, for 7 days. This is the only time the link is shown; use Resend to get a new one.</p>
      </div>
      <ul className="space-y-3">
        {links.map((item) => {
          const id = `link-${item.link.slice(-8)}`;
          const done = copied === item.link;
          return (
            <li key={item.link}>
              <label htmlFor={id} className="label break-words">{item.email}</label>
              <div className="flex gap-2">
                <input id={id} className="input mono min-w-0 flex-1 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" readOnly value={item.link} spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
                <button type="button" className="btn-ghost shrink-0" onClick={() => copy(item)} aria-label={`${done ? "Copied" : "Copy"} invite link for ${item.email}`}>
                  {done ? <Check size={16} strokeWidth={1.75} aria-hidden /> : <Copy size={16} strokeWidth={1.75} aria-hidden />}
                  {done ? "Copied" : "Copy"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <p role="status" aria-live="polite" className="text-xs font-medium text-ink">
        {failed ? "Your browser blocked copying. Select the link and copy it by hand." : copied ? "Link copied." : ""}
      </p>
      <button type="button" className="btn-quiet btn-sm" onClick={onDone}>Done</button>
    </section>
  );
});

export default InviteLinks;
