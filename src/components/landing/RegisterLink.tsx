"use client";
import Link from "next/link";
import { useEffect, useState, type ComponentProps } from "react";
import { withPageUtm } from "@/lib/pricing";

/**
 * A Link that carries the current page's utm_* tags into /register links (registerHref pass-through).
 * The server renders the plain href; after hydration the tags from the address bar are added.
 */
export default function RegisterLink({ href, ...rest }: Omit<ComponentProps<typeof Link>, "href"> & { href: string }) {
  const [tagged, setTagged] = useState(href);
  useEffect(() => {
    setTagged(withPageUtm(href, window.location.search));
  }, [href]);
  return <Link href={tagged} {...rest} />;
}
