import { redirect } from "next/navigation";

/** /settings has no page of its own; Models is the first tab most people need. */
export default function SettingsIndex() {
  redirect("/settings/models");
}
