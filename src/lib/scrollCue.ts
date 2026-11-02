/** Which edges of a horizontally scrolling box still have hidden content. Pure, so it can be tested with mocked sizes. */

export interface ScrollMetrics {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}

export interface ScrollCue {
  overflows: boolean;
  fadeStart: boolean;
  fadeEnd: boolean;
}

export const NO_SCROLL_CUE: ScrollCue = { overflows: false, fadeStart: false, fadeEnd: false };

/** Sub-pixel rounding in browsers can leave a 1px gap at either end. */
const EDGE_TOLERANCE = 1;

export function scrollCue(m: ScrollMetrics): ScrollCue {
  const overflows = m.scrollWidth - m.clientWidth > EDGE_TOLERANCE;
  if (!overflows) return NO_SCROLL_CUE;
  return {
    overflows,
    fadeStart: m.scrollLeft > EDGE_TOLERANCE,
    fadeEnd: m.scrollLeft + m.clientWidth < m.scrollWidth - EDGE_TOLERANCE,
  };
}

export const sameScrollCue = (a: ScrollCue, b: ScrollCue) =>
  a.overflows === b.overflows && a.fadeStart === b.fadeStart && a.fadeEnd === b.fadeEnd;
