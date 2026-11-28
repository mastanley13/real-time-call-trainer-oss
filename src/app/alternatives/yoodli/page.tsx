import ComparePage from "@/components/compare/ComparePage";
import { ALT_YOODLI_PAGE } from "@/lib/seoLandings";
import { pageMetadata } from "@/lib/seo";

const page = ALT_YOODLI_PAGE;

export const metadata = pageMetadata({ title: page.title, description: page.description, path: page.path });

export default function YoodliAlternativePage() {
  return <ComparePage page={page} />;
}
