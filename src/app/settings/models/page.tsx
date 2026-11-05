import ModelsClient from "@/components/settings/ModelsClient";
import { pageTitle } from "@/lib/tenant";

export const metadata = { title: pageTitle("Models") };

export default function ModelsSettingsPage() {
  return <ModelsClient />;
}
