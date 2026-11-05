import PersonaWizard from "@/components/library/PersonaWizard";
import { notFound } from "next/navigation";
import { featureAllowed, pageTitle } from "@/lib/tenant";

export const metadata = { title: pageTitle("New persona") };

export default function NewPersonaPage() {
  if (!featureAllowed("wizard")) notFound();
  return <PersonaWizard />;
}
