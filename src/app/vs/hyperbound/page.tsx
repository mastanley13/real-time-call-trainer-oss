import ComparePage from "@/components/compare/ComparePage";
import { VS_PAGES } from "@/lib/comparisons";
import { pageMetadata } from "@/lib/seo";

const page = VS_PAGES.hyperbound;

export const metadata = pageMetadata({ title: page.title, description: page.description, path: page.path });

export default function VsHyperboundPage() {
  return <ComparePage page={page} />;
}
