import LibraryCatalog from "@/components/library/LibraryCatalog";
import LibraryClient from "@/components/library/LibraryClient";
import { LIBRARY } from "@/lib/personas";
import { pageMetadata } from "@/lib/seo";

const families = new Set(LIBRARY.map((s) => s.role)).size;

export const metadata = pageMetadata({
  title: "Persona library · Real-Time Call Trainer",
  description: `Browse ${LIBRARY.length} AI buyer personas across ${families} sales jobs, from SDR cold calls to insurance renewals. See each buyer's role and industry, then practice the call with a live coach and a graded debrief.`,
  path: "/library",
});

/** The built-in catalog renders on the server so the initial HTML lists every library persona. Signed-in users get the interactive library on top. */
export default function LibraryPage() {
  return <LibraryClient fallback={<LibraryCatalog />} />;
}
