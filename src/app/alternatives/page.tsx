import ComparePage from "@/components/compare/ComparePage";
import { ALTERNATIVES_PAGE } from "@/lib/comparisons";
import { pageMetadata } from "@/lib/seo";

const page = ALTERNATIVES_PAGE;

export const metadata = pageMetadata({ title: page.title, description: page.description, path: page.path });

export default function AlternativesPage() {
  return <ComparePage page={page} />;
}
