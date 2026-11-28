import ComparePage from "@/components/compare/ComparePage";
import { ROLEPLAY_HUB_PAGE } from "@/lib/seoLandings";
import { pageMetadata } from "@/lib/seo";

const page = ROLEPLAY_HUB_PAGE;

export const metadata = pageMetadata({ title: page.title, description: page.description, path: page.path });

export default function AiSalesRoleplayPage() {
  return <ComparePage page={page} />;
}
