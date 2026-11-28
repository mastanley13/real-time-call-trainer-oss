import ComparePage from "@/components/compare/ComparePage";
import { USE_911_PAGE } from "@/lib/seoLandings";
import { pageMetadata } from "@/lib/seo";

const page = USE_911_PAGE;

export const metadata = pageMetadata({ title: page.title, description: page.description, path: page.path });

export default function Dispatch911UseCasePage() {
  return <ComparePage page={page} />;
}
