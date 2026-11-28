import ComparePage from "@/components/compare/ComparePage";
import { ALT_HYPERBOUND_PAGE } from "@/lib/seoLandings";
import { pageMetadata } from "@/lib/seo";

const page = ALT_HYPERBOUND_PAGE;

export const metadata = pageMetadata({ title: page.title, description: page.description, path: page.path });

export default function HyperboundAlternativePage() {
  return <ComparePage page={page} />;
}
