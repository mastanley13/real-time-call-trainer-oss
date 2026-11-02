import "server-only";
import { GHL_FIELD_KEYS, GHL_PIPELINE, actionsFor, type GhlDeliveryMeta, type GhlFieldKey, type GhlPayload, type GhlWebhookBody } from "./types";
import { ghlLog } from "./log";

const API_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

type Env = Record<string, string | undefined>;

/** Always off in DEMO_MODE and unless GHL_SYNC_ENABLED=true, whatever else is set. */
export function ghlEnabled(env: Env = process.env): boolean {
  if (env.DEMO_MODE === "true") return false;
  if (env.GHL_SYNC_ENABLED !== "true") return false;
  return Boolean(env.GHL_INBOUND_WEBHOOK_URL?.trim() || (env.GHL_PIT?.trim() && env.GHL_LOCATION_ID?.trim()));
}

/** Carries the HTTP status only. Provider response bodies are never kept or logged. */
export class GhlHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs?: number) {
    super(`ghl_http_${status}`);
  }
}

/** 429 and 5xx (and network failures, status 0) are worth retrying; other 4xx will not change. */
export const isRetryable = (status: number) => status === 0 || status === 429 || status >= 500;

export type GhlClientOptions = {
  env?: Env;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** In-request attempts per call before the outbox takes over. */
  maxAttempts?: number;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type GhlClient = { send(payload: GhlPayload, meta: GhlDeliveryMeta): Promise<void> };

export function createGhlClient(opts: GhlClientOptions = {}): GhlClient {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const maxAttempts = opts.maxAttempts ?? 3;
  const pit = env.GHL_PIT?.trim() ?? "";
  const locationId = env.GHL_LOCATION_ID?.trim() ?? "";
  const webhookUrl = env.GHL_INBOUND_WEBHOOK_URL?.trim();

  // Resolved once per client and kept for the life of the process.
  let fieldIds: Map<string, string> | undefined;
  let pipeline: { id: string; stages: Map<string, string> } | undefined;

  async function raw(method: string, url: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      let status = 0;
      let retryAfterMs: number | undefined;
      try {
        const res = await doFetch(url, {
          method,
          headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(8000),
          redirect: "manual",
        });
        status = res.status;
        if (res.ok) {
          const text = await res.text();
          try {
            return text ? JSON.parse(text) : {};
          } catch {
            return {};
          }
        }
        const ra = Number(res.headers.get("retry-after"));
        if (Number.isFinite(ra) && ra > 0) retryAfterMs = Math.min(ra * 1000, 30_000);
      } catch {
        status = 0;
      }
      if (!isRetryable(status) || attempt >= maxAttempts) throw new GhlHttpError(status, retryAfterMs);
      const wait = retryAfterMs ?? Math.min(500 * 2 ** (attempt - 1), 8000);
      ghlLog("warn", "retrying", { status, attempt });
      await sleep(wait);
    }
  }

  const api = (method: string, path: string, body?: unknown) =>
    raw(method, `${API_BASE}${path}`, body, { Version: API_VERSION, Authorization: `Bearer ${pit}` }) as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

  async function resolveFieldId(key: GhlFieldKey): Promise<string | undefined> {
    if (!fieldIds) {
      const res = await api("GET", `/locations/${encodeURIComponent(locationId)}/customFields`);
      fieldIds = new Map();
      for (const f of (res.customFields ?? []) as Array<{ id?: string; fieldKey?: string }>) {
        if (f.id && f.fieldKey) fieldIds.set(f.fieldKey.replace(/^contact\./, ""), f.id);
      }
    }
    return fieldIds.get(key);
  }

  async function resolvePipeline() {
    if (!pipeline) {
      const res = await api("GET", `/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`);
      const found = ((res.pipelines ?? []) as Array<{ id: string; name: string; stages?: Array<{ id: string; name: string }> }>).find((p) => p.name === GHL_PIPELINE);
      if (!found) throw new GhlHttpError(404);
      pipeline = { id: found.id, stages: new Map((found.stages ?? []).map((s) => [s.name, s.id])) };
    }
    return pipeline;
  }

  async function sendViaApi(p: GhlPayload) {
    const actions = actionsFor(p);

    const up = await api("POST", "/contacts/upsert", { locationId, email: p.user.email, firstName: p.user.firstName || undefined });
    const contactId: string | undefined = up.contact?.id;
    if (!contactId) throw new GhlHttpError(502);

    if (actions.addTags.length) await api("POST", `/contacts/${contactId}/tags`, { tags: actions.addTags });
    if (actions.removeTags.length) await api("DELETE", `/contacts/${contactId}/tags`, { tags: actions.removeTags });

    const customFields: Array<{ id: string; field_value: string | number }> = [];
    for (const key of GHL_FIELD_KEYS) {
      const value = actions.fields[key];
      if (value === undefined) continue;
      const id = await resolveFieldId(key);
      if (id) customFields.push({ id, field_value: value });
      else ghlLog("warn", "field_not_found", { field: key });
    }
    if (customFields.length) await api("PUT", `/contacts/${contactId}`, { customFields });

    const pl = await resolvePipeline();
    const stageId = pl.stages.get(actions.stage);
    if (!stageId) throw new GhlHttpError(404);
    const found = await api("GET", `/opportunities/search?location_id=${encodeURIComponent(locationId)}&pipeline_id=${encodeURIComponent(pl.id)}&contact_id=${encodeURIComponent(contactId)}`);
    const existing: string | undefined = found.opportunities?.[0]?.id;
    if (existing) {
      await api("PUT", `/opportunities/${existing}`, { pipelineStageId: stageId });
    } else {
      await api("POST", "/opportunities/", {
        pipelineId: pl.id,
        locationId,
        name: p.user.firstName ? `${p.user.firstName} (Call Trainer trial)` : "Call Trainer trial",
        pipelineStageId: stageId,
        status: "open",
        contactId,
      });
    }
  }

  return {
    async send(payload, meta) {
      if (webhookUrl) {
        // Every attempt of one event, including in-request retries after a lost response, carries
        // the same eventId and Idempotency-Key so the receiver can drop the duplicate.
        const body: GhlWebhookBody = { ...payload, ...meta };
        await raw("POST", webhookUrl, body, { "Idempotency-Key": meta.eventId });
        return;
      }
      await sendViaApi(payload);
    },
  };
}
