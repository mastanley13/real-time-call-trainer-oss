"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AudioLines, ClipboardCheck, Loader2, MessageSquareText, PlugZap, Radar, Server, WandSparkles, type LucideIcon } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { PageSkeleton } from "@/components/ui/Skeleton";
import SettingsNav from "./SettingsNav";
import { jobRows, voiceEngines, type JobId } from "./models";
import type { LlmCheckResult } from "@/app/api/llm/hints";

const JOB_ICON: Record<JobId, LucideIcon> = { coach: Radar, grading: ClipboardCheck, wizard: WandSparkles, caller: MessageSquareText };
const COLS = "sm:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)_minmax(0,1.25fr)]";

type Check = { state: "idle" } | { state: "running" } | { state: "done"; result: LlmCheckResult } | { state: "error"; message: string };

function CheckResult({ check, keySet }: { check: Check; keySet: boolean }) {
  if (check.state === "idle" || check.state === "running") return null;
  if (check.state === "error") return <p className="banner-warn mt-4">{check.message}</p>;
  const r = check.result;
  // A missing key is a setup step, not a failure, so it reads as caution rather than alert.
  const t = r.ok ? "ok" : !keySet && r.status === null ? "caution" : "alert";
  const box = { ok: "border-ok/40 bg-ok-soft", caution: "border-caution/40 bg-caution-soft", alert: "border-alert/40 bg-alert-soft" }[t];
  const lamp = { ok: "lamp-ok", caution: "lamp-caution", alert: "lamp-alert" }[t];
  return (
    <div className={`mt-4 rounded-lg border p-3 text-sm text-ink ${box}`}>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-2 font-semibold"><span className={`lamp ${lamp}`} aria-hidden />{r.ok ? "Connected" : t === "caution" ? "No key configured" : "Connection failed"}</span>
        {r.latencyMs !== null && <span className="mono text-xs text-ink-soft">{r.latencyMs} ms</span>}
        {r.status !== null && !r.ok && <span className="mono text-xs text-ink-soft">HTTP {r.status}</span>}
        <span className="chip-model">{r.model}</span>
      </p>
      <p className="mt-1.5 text-ink-soft">{r.hint}</p>
    </div>
  );
}

export default function ModelsClient() {
  const { isAuthenticated, isLoading, capabilities } = useAuth();
  const router = useRouter();
  const [check, setCheck] = useState<Check>({ state: "idle" });

  // Wait for /api/config: demo mode signs in only once capabilities arrive.
  useEffect(() => {
    if (capabilities && !isLoading && !isAuthenticated) router.replace("/login");
  }, [capabilities, isLoading, isAuthenticated, router]);

  async function runCheck() {
    if (check.state === "running") return;
    setCheck({ state: "running" });
    try {
      const res = await fetch("/api/llm/check", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) throw new Error("Your session expired. Sign in again to check the connection.");
      if (!res.ok) throw new Error(data.message || "The check couldn't run. Try again in a minute.");
      setCheck({ state: "done", result: data as LlmCheckResult });
    } catch (e) {
      setCheck({ state: "error", message: e instanceof TypeError ? "Your browser couldn't reach this server. Check your connection and try again." : e instanceof Error ? e.message : "The check couldn't run." });
    }
  }

  if (!capabilities || !isAuthenticated) return <PageSkeleton rows={3} />;

  const caps = capabilities as unknown as Record<string, unknown>;
  const keySet = capabilities.llm;
  const jobs = jobRows(caps);
  const voices = voiceEngines(caps);
  const running = check.state === "running";

  return (
    <div className="page enter max-w-5xl space-y-6">
      <SettingsNav />
      <header>
        <p className="eyebrow">Settings</p>
        <h1 className="mt-1 text-3xl font-bold">Models</h1>
        <p className="mt-2 max-w-2xl text-ink-soft">Each AI job in the app, the model that runs it, and what takes over without a working key. Keys and endpoint URLs stay on the server and never appear here.</p>
      </header>

      <section className="panel p-4 sm:p-5" aria-labelledby="provider-h">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="provider-h" className="label">Provider</h2>
            <p className="flex items-center gap-2 font-heading text-lg font-semibold">
              <Server size={18} strokeWidth={1.75} className="text-primary" aria-hidden />
              {capabilities.provider === "custom" ? "Custom OpenAI-compatible endpoint" : "OpenAI"}
            </p>
            <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-6 gap-y-2 text-sm">
              <dt className="text-ink-muted">API key</dt>
              <dd className="flex items-center gap-2"><span className={`lamp ${keySet ? "lamp-ok" : "lamp-off"}`} aria-hidden />{keySet ? "Set on the server" : "Not set"}</dd>
              <dt className="text-ink-muted">Model</dt>
              <dd><span className="chip-model">{capabilities.model ?? "not reported"}</span></dd>
            </dl>
          </div>
          {/* aria-disabled, not disabled, so keyboard focus stays on the button while the check runs. */}
          <button type="button" className="btn-ghost" onClick={runCheck} aria-disabled={running} aria-busy={running}>
            {running ? <Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden /> : <PlugZap size={16} strokeWidth={1.75} aria-hidden />}
            {running ? "Checking" : "Check connection"}
          </button>
        </div>
        <div role="status" aria-live="polite"><CheckResult check={check} keySet={keySet} /></div>
        <p className="mt-4 text-xs text-ink-muted">The check sends one tiny request (a single output token) with the server&rsquo;s key and model. You can run it 6 times every 10 minutes.</p>
      </section>

      <section aria-labelledby="jobs-h" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="jobs-h" className="text-lg font-bold">Who does what</h2>
          <p className="font-mono text-[11px] text-ink-muted">{keySet ? "AI on · fallbacks on standby" : "no key · fallbacks running"}</p>
        </div>
        <div className="panel">
          <div className={`hidden gap-4 border-b border-line px-4 py-2.5 sm:grid ${COLS}`} aria-hidden>
            <span className="label !mb-0">Job</span><span className="label !mb-0">Runs on now</span><span className="label !mb-0">Without a working key</span>
          </div>
          <ul className="divide-y divide-line">
            {jobs.map((j) => {
              const Icon = JOB_ICON[j.id];
              return (
                <li key={j.id} className={`grid gap-3 px-4 py-4 sm:gap-4 ${COLS}`}>
                  <div className="flex min-w-0 gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary"><Icon size={18} strokeWidth={1.75} aria-hidden /></span>
                    <div className="min-w-0">
                      <h3 className="text-[15px] font-semibold">{j.name}</h3>
                      <p className="text-sm text-ink-soft">{j.detail}</p>
                    </div>
                  </div>
                  <div className="sm:pt-0.5">
                    <p className="label sm:hidden">Runs on now</p>
                    <span className="chip-model max-w-full"><span className={`lamp ${j.ai ? "lamp-ok" : "lamp-caution"} !h-1.5 !w-1.5`} aria-hidden /><span className="truncate">{j.engine}</span></span>
                  </div>
                  <div className="min-w-0 text-sm">
                    <p className="label sm:hidden">Without a working key</p>
                    <p className="font-semibold">{j.fallbackName}</p>
                    <p className="text-ink-soft">{j.fallback}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section aria-labelledby="voice-h" className="space-y-3">
        <h2 id="voice-h" className="text-lg font-bold">Voice engines</h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {voices.map((v) => (
            <li key={v.id} className="panel flex gap-3 p-4">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary"><AudioLines size={18} strokeWidth={1.75} aria-hidden /></span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-[15px] font-semibold">{v.label}</h3>
                  {v.model && <span className="chip-model">{v.model}</span>}
                  {v.preferred && voices.filter((x) => x.available).length > 1 && <span className="chip">Used first</span>}
                </div>
                <p className="mt-1 flex items-center gap-2 text-sm"><span className={`lamp ${v.available ? "lamp-ok" : "lamp-off"}`} aria-hidden />{v.available ? "Ready for voice calls" : "Not set up"}</p>
                <p className="mt-1 text-xs text-ink-muted">
                  {!v.available ? v.setup : v.id === "elevenlabs" ? "The voice, language and model are chosen in your ElevenLabs agent." : v.id === "realtime" ? "Speaks as the persona and transcribes you, live in the browser." : "Plays the persona on voice calls."}
                </p>
              </div>
            </li>
          ))}
        </ul>
        {!voices.some((v) => v.available) && <p className="text-sm text-ink-soft">No voice engine is set up, so practice calls run by text and the text caller plays the persona.</p>}
      </section>

      <section className="panel p-4 sm:p-5" aria-labelledby="nokey-h">
        <h2 id="nokey-h" className="label">When there&rsquo;s no working key</h2>
        <p className="text-sm text-ink-soft">Practice keeps working. With no key, every job above uses its fallback. With a key that fails, only the failed request falls back, and the next one tries the model again. Rules-based grades show as estimates on the debrief, and you can re-grade them with AI once the key works.</p>
        <p className="mt-3 text-sm text-ink-soft">To turn AI on, set <code className="kbd">LLM_API_KEY</code> on the server and restart it. <code className="kbd">LLM_MODEL</code> picks the model and <code className="kbd">LLM_BASE_URL</code> points at any OpenAI-compatible endpoint. The README has the details.</p>
      </section>
    </div>
  );
}
