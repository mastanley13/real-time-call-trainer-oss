/**
 * Landing hero example: three real turns from the water-heater scenario and the one coach cue they triggered.
 * Static and server-rendered: no client code, no score, no microphone. Clearly labelled as an example session.
 */

export type ExampleTurn = { speaker: string; role: "buyer" | "rep"; at: string; text: string };

export const EXAMPLE_PERSONA = { name: "Dana Whitfield", context: "Inbound lead, water heater" };

export const EXAMPLE_TURNS: ExampleTurn[] = [
  { speaker: "Dana", role: "buyer", at: "00:52", text: "It started this morning. There’s a puddle by the base of the tank." },
  { speaker: "You", role: "rep", at: "01:02", text: "How old is the unit, and is the leak from the bottom of the tank or a pipe?" },
  { speaker: "Dana", role: "buyer", at: "01:14", text: "What does a visit cost? Nobody mentioned a fee." },
];

export const EXAMPLE_CUE = { title: "Price objection", message: "Name the fee before you offer a time slot." };

export default function HeroDeck() {
  return (
    <section aria-labelledby="example-h" className="min-w-0 overflow-hidden rounded-panel border border-line bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-5 md:px-6">
        <div className="min-w-0">
          <h2 id="example-h" className="text-lg font-bold leading-7">
            <span className="sr-only">Example session with </span>{EXAMPLE_PERSONA.name}
          </h2>
          <p className="text-sm leading-5 text-ink-soft">{EXAMPLE_PERSONA.context}</p>
        </div>
        <span className="badge-tag" aria-hidden="true">Example session</span>
      </div>

      <div className="flex flex-col gap-6 p-5 md:p-6">
        <ol role="list" aria-label="Transcript" className="flex list-none flex-col gap-6">
          {EXAMPLE_TURNS.map((t) => (
            <li key={t.at} className="grid grid-cols-[48px_minmax(0,1fr)] gap-3 md:grid-cols-[56px_minmax(0,1fr)] md:gap-4">
              <p className="text-sm leading-5">
                <span className="block font-semibold text-ink">{t.speaker}</span>
                <span className="sr-only">, {t.role}, at </span>
                <span className="block tabular-nums text-ink-soft">{t.at}</span>
              </p>
              <p className="break-words text-lg leading-7 text-ink md:text-[20px] md:leading-[31px]">{t.text}</p>
            </li>
          ))}
        </ol>

        <div role="note" aria-label="Coach cue" className="rounded-r-control border-l-4 border-primary bg-sunken p-4 md:p-5">
          <p className="text-sm font-semibold leading-5 text-ink">Coach cue: {EXAMPLE_CUE.title.toLowerCase()}</p>
          <p className="mt-1 text-base leading-6 text-ink">{EXAMPLE_CUE.message}</p>
        </div>
      </div>
    </section>
  );
}
