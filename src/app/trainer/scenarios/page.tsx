import ScenarioEditor from "@/components/ScenarioEditor";

export const metadata = { title: "Scenario editor · Real-Time Call Trainer" };

/** Server wrapper so the page has its own title; the editor itself is a client component that reads this browser's storage. */
export default function ScenariosPage() {
  return <ScenarioEditor />;
}
