/** Public legal pages, linked from the site footer and the sign-in and sign-up pages. */
export const LEGAL_LINKS = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
] as const;

/** Support contact, linked from every footer. */
export const CONTACT_LINK = { href: "mailto:support@calltrainer.tech", label: "Contact" } as const;
