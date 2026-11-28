import ComparePage from "@/components/compare/ComparePage";
import { USE_ALARM_PAGE } from "@/lib/seoLandings";
import { pageMetadata } from "@/lib/seo";

const page = USE_ALARM_PAGE;

export const metadata = pageMetadata({ title: page.title, description: page.description, path: page.path });

export default function AlarmMonitoringUseCasePage() {
  return <ComparePage page={page} />;
}
