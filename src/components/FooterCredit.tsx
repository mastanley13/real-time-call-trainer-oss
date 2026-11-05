import { brand } from "@/lib/tenant";

/**
 * The credit line in the site and landing footers. OSS builds keep the MIT credit. A branded tenant shows its name,
 * "powered by Real-Time Call Trainer" when brand.poweredBy is on, the legal operator and, if set, its disclaimer.
 */
export default function FooterCredit() {
  return (
    <>
      {brand.showOssSections ? (
        <p>MIT licensed · by Mykel Stanley · originally based on OpenAI&rsquo;s openai-realtime-agents demo</p>
      ) : (
        <p>
          {brand.name}
          {brand.poweredBy && (
            <> · powered by <a href={brand.upstreamUrl} className="underline-offset-2 hover:text-ink hover:underline" target="_blank" rel="noreferrer">Real-Time Call Trainer</a></>
          )}
          {" · "}operated by {brand.operatorName}
        </p>
      )}
      {brand.disclaimer && <p className="mx-auto mt-1 max-w-2xl text-xs">{brand.disclaimer}</p>}
    </>
  );
}
