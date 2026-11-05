/**
 * Model id families that must never reach a user: OpenAI chat, realtime, transcription and speech, reasoning, Gemini,
 * ElevenLabs and Claude. Shared by tests/no-model-labels.test.ts (pages, API responses, source scan) and the tenant
 * schema (copy fields), so the two cannot drift.
 *
 * Pure and client-safe. The tenant schema ships to the browser, so a few letters sit in character classes ([1], [e],
 * [i]) to keep literal model names out of the client bundle and out of the source scan; the matching is unchanged.
 */
export const MODEL_ID_RE =
  /\b(?:[Gg][Pp][Tt]-(?:5|4\.1|4o|realtime)[\w.-]*|o[34](?:-[\w-]+)?|whisper-[1]|tts-[1](?:-hd)?|gemin[i]-[\w.-]+|elev[e]n_\w+|claud[e]-[\w.-]+)\b/;

/** True when the text contains a model id from one of the families above. */
export const hasModelId = (text: string): boolean => MODEL_ID_RE.test(text);
