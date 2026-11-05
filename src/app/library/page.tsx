import LibraryClient from "@/components/library/LibraryClient";
import { pageTitle } from "@/lib/tenant";

export const metadata = { title: pageTitle("Persona library") };

export default function LibraryPage() {
  return <LibraryClient />;
}
