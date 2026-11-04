import "server-only";
import { buildAgentPrompt, type Scenario } from "./scenarios";
import { realtimeTranscribeModel } from "./realtime";

/**
 * OpenAI Realtime calls through the unified interface, made with the server's API key only
 * (https://developers.openai.com/api/docs/guides/realtime-webrtc, "Connecting using the unified interface"):
 * POST /v1/realtime/calls with multipart fields `sdp` and `session`, the call id in the `Location` header, and
 * POST /v1/realtime/calls/{call_id}/hangup to end it. The browser never receives an OpenAI credential, so it
 * cannot open calls the server does not know about.
 */

const CALLS_URL = "https://api.openai.com/v1/realtime/calls";

/** Call ids go into a URL path, so only a plain token is accepted. */
const CALL_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** The session config for one practice call, built on the server from the persona. */
export function buildRealtimeSession(scenario: Scenario, model: string, voice: string) {
  return {
    type: "realtime",
    model,
    // Same persona prompt as ElevenLabs and the text caller: stays in character and never coaches.
    instructions: buildAgentPrompt(scenario),
    output_modalities: ["audio"],
    audio: {
      input: {
        // Needed for the transcript, the live coach and grading: the realtime model itself never returns user text.
        transcription: { model: realtimeTranscribeModel() },
        // semantic_vad waits for a finished thought, so a trainee who pauses mid-pitch is not talked over.
        turn_detection: { type: "semantic_vad", eagerness: "auto", create_response: true, interrupt_response: true },
        noise_reduction: { type: "near_field" },
      },
      output: { voice },
    },
  };
}

export type OpenedCall = { ok: true; sdp: string; providerCallId: string } | { ok: false; status: number };

/**
 * Opens the provider call with the browser's SDP offer. Status 0 means no usable answer (network error, or a response
 * with no SDP or no call id: a call the server cannot hang up is not handed to the browser). Logs the status only.
 */
export async function openProviderCall(apiKey: string, sdp: string, session: object): Promise<OpenedCall> {
  try {
    const form = new FormData();
    form.set("sdp", sdp);
    form.set("session", JSON.stringify(session));
    const res = await fetch(CALLS_URL, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      console.error("[realtime/calls] upstream status", res.status);
      return { ok: false, status: res.status };
    }
    const providerCallId = res.headers.get("location")?.split("/").pop() ?? "";
    const answer = await res.text();
    if (!CALL_ID.test(providerCallId) || !answer.trim()) {
      console.error("[realtime/calls] response without a call id or SDP");
      // A call may exist that we cannot name; nothing more can be done from here.
      return { ok: false, status: 0 };
    }
    return { ok: true, sdp: answer, providerCallId };
  } catch (e) {
    console.error("[realtime/calls]", e instanceof Error ? e.name : "unknown error");
    return { ok: false, status: 0 };
  }
}

/** Ends a provider call. True when it is over (200, or 404 because it already ended). Never throws; status only in logs. */
export async function hangupProviderCall(apiKey: string, providerCallId: string): Promise<boolean> {
  if (!CALL_ID.test(providerCallId)) return false;
  try {
    const res = await fetch(`${CALLS_URL}/${providerCallId}/hangup`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (res.ok || res.status === 404) return true;
    console.error("[realtime/hangup] upstream status", res.status);
    return false;
  } catch (e) {
    console.error("[realtime/hangup]", e instanceof Error ? e.name : "unknown error");
    return false;
  }
}
