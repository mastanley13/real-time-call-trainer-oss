"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { AgentState } from "@/components/ui/orb";

export type { AgentState };

const ORB_COLORS: [string, string] = ["#1D4ED8", "#14B8A6"];

/** Static brand gradient: SSR/loading state, reduced-motion users, and browsers without WebGL. */
function OrbFallback({ state }: { state: AgentState }) {
  return (
    <div className="flex h-full w-full items-center justify-center" aria-hidden>
      <div
        className={`h-[78%] w-[78%] rounded-full bg-[radial-gradient(circle_at_30%_25%,#5eead4,#1D4ED8_70%)] shadow-orb ${state === "talking" ? "motion-safe:animate-orb-talk" : state ? "motion-safe:animate-orb-breathe" : ""}`}
      />
    </div>
  );
}

const Orb = dynamic(() => import("@/components/ui/orb").then((m) => m.Orb), { ssr: false, loading: () => <OrbFallback state={null} /> });

function canUseWebGL() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

interface Props {
  state: AgentState;
  getInputVolume?: () => number;
  getOutputVolume?: () => number;
  /** Text mode has no audio: drive the orb with fixed levels instead. */
  manual?: { input: number; output: number };
  className?: string;
}

export default function CallOrb({ state, getInputVolume, getOutputVolume, manual, className = "" }: Props) {
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setAnimated(!mq.matches && canUseWebGL());
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  return (
    <div className={`relative aspect-square ${className}`}>
      {animated ? (
        <Orb
          colors={ORB_COLORS}
          agentState={state}
          {...(manual
            ? { volumeMode: "manual" as const, manualInput: manual.input, manualOutput: manual.output }
            : { getInputVolume, getOutputVolume })}
        />
      ) : (
        <OrbFallback state={state} />
      )}
    </div>
  );
}
