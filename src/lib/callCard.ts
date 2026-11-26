/**
 * Pure helper that builds a concise, spoiler-free Role-Play Entry Card for any call
 * (official competition tracks, built-in library personas, or custom 1-URL personas).
 * Never exposes hidden facts from aiPersona.behavior.
 */
import { competitionTrackByScenarioId, type CompetitionRoleCard } from "./competition";
import { CALL_TYPE_LABELS, jobFamilyLabel, type Scenario } from "./scenarios";

const ROLE_TITLES: Record<string, string> = {
  sdr: "Sales Development Rep (SDR)",
  ae: "Account Executive",
  cs: "Customer Success Manager",
  "home-services": "Home Services Specialist",
  insurance: "Licensed Insurance Agent",
  mortgage: "Mortgage Loan Officer",
  "real-estate": "Real Estate Agent",
  solar: "Solar Consultant",
  auto: "Automotive Sales Specialist",
  medical: "Medical Device Rep",
  procurement: "Enterprise Account Executive",
  recruiting: "Recruiting Consultant",
  retail: "Retail Sales Associate",
  collections: "Accounts Receivable Specialist",
  financial: "Financial Advisor",
  logistics: "Logistics Sales Rep",
  telecom: "Telecom Sales Rep",
  general: "Sales Representative",
};

/**
 * Strips leading call-type labels from a scenario title so it reads cleanly as the offer/topic,
 * e.g. "Inbound lead: leaking water heater" -> "Leaking water heater".
 */
function topicFromTitle(title: string): string {
  const cleaned = title.replace(/^[^:]{2,28}:\s*/, "").trim();
  if (!cleaned) return title.trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Returns a clean, spoiler-free RolePlayCard for any scenario.
 * Canonical competition scenarios use their hand-crafted track roleCard;
 * all other library and custom scenarios derive clean values from public briefing fields only.
 */
export function buildRolePlayCard(
  scenario: Pick<Scenario, "id" | "role" | "industry" | "title" | "callType" | "aiPersona">,
  explicitCard?: CompetitionRoleCard | null,
): CompetitionRoleCard {
  if (explicitCard) return explicitCard;
  const track = competitionTrackByScenarioId(scenario.id);
  if (track) return track.roleCard;

  const baseRole = ROLE_TITLES[scenario.role] ?? jobFamilyLabel(scenario.role);
  const industry = scenario.industry.trim();
  const yourRole =
    industry && !baseRole.toLowerCase().includes(industry.toLowerCase())
      ? `${baseRole} · ${industry}`
      : baseRole;

  const pitching = topicFromTitle(scenario.title) || `${CALL_TYPE_LABELS[scenario.callType]} call`;
  const who = scenario.aiPersona.role.trim();
  const situation = who
    ? `You are on a ${CALL_TYPE_LABELS[scenario.callType].toLowerCase()} call with ${scenario.aiPersona.name}: ${who.charAt(0).toLowerCase() + who.slice(1).replace(/\.$/, "")}.`
    : `You are entering a ${CALL_TYPE_LABELS[scenario.callType].toLowerCase()} call with ${scenario.aiPersona.name}.`;

  return {
    yourRole,
    pitching,
    situation,
    openingLine: scenario.aiPersona.openingLine.trim(),
  };
}
