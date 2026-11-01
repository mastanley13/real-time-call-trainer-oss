/** Pure behaviour for the narrow-screen header menu, kept out of the component so it can be tested without a DOM. */

export const MOBILE_MENU_ID = "mobile-menu";

export interface Focusable {
  focus(): void;
}

export const menuButtonLabel = (open: boolean) => (open ? "Close menu" : "Open menu");

/** Escape closes an open menu. Returns true when the key was handled. */
export function handleMenuKey(key: string, open: boolean, close: () => void): boolean {
  if (!open || key !== "Escape") return false;
  close();
  return true;
}

/** Closes the menu and hands focus back to the button that opened it. */
export function closeMenu(setOpen: (open: boolean) => void, button: Focusable | null): void {
  setOpen(false);
  button?.focus();
}

/** Matches Tailwind's `max-md` (below 768px), the range where the menu button is visible. */
export const MOBILE_MENU_QUERY = "(max-width: 767px)";

export const FOCUSABLE_SELECTOR = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

export interface Closest {
  closest(selector: string): unknown;
}

/**
 * Closes the menu after a click outside it. If the click landed on something that cannot take focus,
 * the browser drops focus to the page body, so hand it back to the button. A focusable target keeps its own focus.
 */
export function dismissOutside(target: Closest | null, setOpen: (open: boolean) => void, button: Focusable | null): void {
  setOpen(false);
  if (!target?.closest(FOCUSABLE_SELECTOR)) button?.focus();
}

/** The viewport left the menu's range. Resets the menu, and moves focus off the now hidden panel if it was there. */
export function leaveMobileRange(setOpen: (open: boolean) => void, focusWasInside: boolean, fallback: Focusable | null): void {
  setOpen(false);
  if (focusWasInside) fallback?.focus();
}

/** Matches Tailwind's `sm` (640px and up), where Sign in and Get started show in the bar and their panel copies are hidden. */
export const GUEST_LINKS_IN_BAR_QUERY = "(min-width: 640px)";

/**
 * The panel copies of Sign in and Get started disappear when the viewport reaches `sm`. If one had focus, move it to the
 * matching link in the bar, or to the menu button when that link is missing. Returns true when focus was moved.
 */
export function refocusGuestLink(activeGuestHref: string | null, findBarLink: (href: string) => Focusable | null, button: Focusable | null): boolean {
  if (!activeGuestHref) return false;
  (findBarLink(activeGuestHref) ?? button)?.focus();
  return true;
}

/** Moves focus to the first link in the panel after it opens. */
export function focusFirstLink(links: ArrayLike<Focusable>): void {
  links[0]?.focus();
}
