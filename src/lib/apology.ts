/** Apology detection shared by the live coach (talk-track steps) and the rules-based grader (rubric criteria). */

/**
 * A real apology. Test one sentence at a time with isApology: "Sorry, could you repeat that?" and
 * "I'm sorry, I didn't catch that" ask the caller to repeat, and "I won't apologize" is not one.
 */
const APOLOGY_RE =
  /\b((i['’]m|i am|we['’]re|we are) (so |very |really |truly |deeply )?sorry(?!,? (what|could|can|would|say|come again|did you|who|where|which|is that|go ahead|you (said|mean)|i (didn['’]t|did not|couldn['’]t|could not|can['’]t|cannot) (catch|hear|get)|i missed (that|what|the))\b)|sorry (about|for|that|to hear|(this|it|we|you)\b(?! (said|mean)\b))|(i|we) (sincerely |truly |really )?apologi[sz]e|(i|we)( just| really| also)?(['’]d| would| want| wanted| need| have)( (just |really )?like)? to (sincerely |personally )?apologi[sz]e|let me (start by |begin by |first )?apologi[sz](e|ing)|(my|our) (sincere |deepest )?apolog(y|ies)|apologies (for|about)|owe you an apology|(that|it)(['’]s| is| was) (completely |entirely |all )?(our|my) (fault|mistake)|(the|that) (miss|mistake|failure|fault) (was|is) (ours|mine)|we (dropped the ball|let you down|messed up|screwed up|got (that|this|it) wrong))\b/i;
/** Owning the mistake also counts, but "The first diagnostic visit, that's on us" gives something away. */
const ON_US_RE = /\b(that['’]s|that is|that was|this is|this was) (all |completely |entirely )?on (us|me)\b/i;
const FREEBIE_RE = /\b(free|no charge|complimentary|waived?|lunch|coffee|dinner|drinks|first (\w+ )?(visit|month|hour|session|consultation))\b/i;
/** In a question only a clear apology counts: "I'm sorry?" and "Sorry, you said Tuesday?" ask the caller to repeat. */
const CLEAR_APOLOGY_RE = /\b(sorry (about|for|that|to hear)|(i|we) (sincerely |truly |really )?apologi[sz]e|apologi[sz](e|ing) (for|about)|apologies (for|about)|(my|our) (sincere |deepest )?apolog(y|ies))\b/i;

/**
 * Deflections dressed as apologies: "I'm sorry, but that's how the queue works", "sorry if that came across badly",
 * "sorry you feel that way", "sorry, one second". Removed before testing, so "I'm sorry, but we dropped the ball" still counts.
 */
const DEFLECT_RE =
  /\bsorry,?\s+(but|if|you feel|you['’]re (upset|frustrated|unhappy|annoyed|disappointed)|let me|one (sec|second|moment)|hold on|bear with|to (interrupt|bother))\b|\b(apologi[sz]e|apologies),?\s+(but|if)\b/gi;

export function isApology(sentence: string): boolean {
  const s = sentence.replace(DEFLECT_RE, " ");
  const onUs = ON_US_RE.exec(s);
  const owned = Boolean(onUs && !FREEBIE_RE.test(s.slice(0, onUs.index)));
  if (!owned && !APOLOGY_RE.test(s)) return false;
  return !s.endsWith("?") || CLEAR_APOLOGY_RE.test(s);
}

/**
 * Steps and rubric criteria that ask for an apology. Not one that applies only "if" something happens, and not
 * "without apologizing", "no need to apologize", "rather than apologize", "without hedging, or apologizing", or the
 * third-person rubric forms "avoids apologizing", "doesn't apologize", "makes no apology", "apology-free".
 * "Don't interrupt, apologize" still asks for one.
 */
export const APOLOGY_STEP_RE =
  /^(?!.*\b(if|unless)\b[^.;]*\bapolog)(?!.*\b(without|never|not|no need to|don['’]t|doesn['’]t|avoids?|avoiding|refrains? from|refraining from|makes no|offers no|with no|free of|instead of|rather than)\b([^.;,]*|[^.;]*,[^.;,]*\b(or|nor) )\bapolog)(?!.*\b(stops?|stopping|skips?|skipping) (the |any |your )?apolog)(?!.*\bapolog\w*-free\b).*\b(apolog\w*|say(ing)? sorry)\b/i;
