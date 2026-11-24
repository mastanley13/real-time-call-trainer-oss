import type { KeyboardEvent } from "react";

/**
 * Keyboard model for a role="radiogroup" of buttons (WAI-ARIA radio pattern), also used for a
 * role="tablist": the group is one Tab stop (give the checked option tabIndex 0 and the rest -1),
 * and the arrow keys move to and select the next enabled option. Put the handler on the group element.
 */
export function radioKeys<T>(options: readonly T[], value: T, onChange: (v: T) => void, isDisabled: (v: T) => boolean = () => false) {
  return (e: KeyboardEvent<HTMLElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const radios = e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"], [role="tab"]');
    let i = Math.max(0, options.indexOf(value));
    for (let n = 0; n < options.length; n++) {
      i = (i + step + options.length) % options.length;
      if (isDisabled(options[i])) continue;
      onChange(options[i]);
      radios[i]?.focus();
      return;
    }
  };
}
