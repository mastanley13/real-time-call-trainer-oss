/**
 * The one OpenAI host check. Pure and client-safe: serverConfig.ts, openaiKeys.ts and the isomorphic realtime.ts
 * all import it, so the chat and voice paths can never disagree about what counts as OpenAI.
 */

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** Exact host match over https, optional :443, then a path or the end. \b alone would also accept api.openai.com.attacker.example. */
export const isOpenAiBaseUrl = (url: string): boolean => /^https:\/\/api\.openai\.com(?::443)?(?:\/|$)/i.test(url.trim());
