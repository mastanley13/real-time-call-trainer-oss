"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { AgentState } from "@/components/ui/orb";

export type { AgentState };

/** A token from globals.css (an RGB triplet) as a color three.js can parse, read where the orb sits so the .deck scope applies. */
function tokenColor(el: Element, name: string): string | null {
  const rgb = getComputedStyle(el).getPropertyValue(name).trim().split(/\s+/);
  return rgb.length === 3 ? `rgb(${rgb.join(", ")})` : null;
}

/** Static brand gradient: SSR/loading state, reduced-motion users, and browsers without WebGL. */
function OrbFallback({ state }: { state: AgentState }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center" aria-hidden>
      <div
        className={`h-[78%] w-[78%] rounded-full bg-[radial-gradient(circle_at_30%_25%,rgb(var(--primary-hover)),rgb(var(--primary))_70%)] shadow-glow ${state === "talking" ? "motion-safe:animate-orb-talk" : state ? "motion-safe:animate-orb-breathe" : ""}`}
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
  const [settled, setSettled] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  /** The orb's two hues come from the signal and ok tokens, so changing globals.css recolors it too. */
  const [colors, setColors] = useState<[string, string] | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const a = tokenColor(ref.current, "--signal"), b = tokenColor(ref.current, "--ok");
    if (a && b) setColors([a, b]);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setAnimated(!mq.matches && canUseWebGL());
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Keep the soft placeholder under the WebGL canvas until it has had time to draw, so there is no blank frame.
  useEffect(() => {
    if (!animated) return;
    const t = setTimeout(() => setSettled(true), 900);
    return () => clearTimeout(t);
  }, [animated]);

  return (
    <div ref={ref} className={`relative aspect-square ${className}`}>
      {(!animated || !settled || !colors) && <OrbFallback state={animated ? null : state} />}
      {animated && colors && (
        <div className="absolute inset-0"><Orb
          colors={colors}
          agentState={state}
          {...(manual
            ? { volumeMode: "manual" as const, manualInput: manual.input, manualOutput: manual.output }
            : { getInputVolume, getOutputVolume })}
        /></div>
      )}
    </div>
  );
}
