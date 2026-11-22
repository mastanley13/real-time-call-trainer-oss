"use client";

import { useState } from "react";
import { Check, Copy, Download, KeyRound } from "lucide-react";
import { recoveryCodesFile } from "@/lib/mfaRecovery-types";

/**
 * Shows freshly issued recovery codes, once. The server keeps only hashes, so when this panel is dismissed the
 * codes cannot be shown again; the only way to get more is to regenerate.
 */
export default function RecoveryCodesPanel({
  codes,
  account,
  onDone,
}: {
  codes: string[];
  account?: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopyFailed(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // The codes stay on screen to copy by hand.
      setCopyFailed(true);
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([recoveryCodesFile(codes, { account })], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "call-trainer-recovery-codes.txt";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section aria-labelledby="recovery-codes-title" className="card mb-4">
      <div className="flex items-center gap-2 mb-2">
        <KeyRound size={20} strokeWidth={1.75} className="text-primary" aria-hidden />
        <h2 id="recovery-codes-title" className="text-sm font-semibold text-ink">
          Save your recovery codes
        </h2>
      </div>
      <p className="banner-warn mb-4">
        Each code works once. Use one to sign in if you lose your authenticator app. Store them somewhere safe, like a
        password manager. You will not see these codes again.
      </p>
      <ul aria-label="Recovery codes" className="grid grid-cols-2 gap-2 mb-4">
        {codes.map((c) => (
          <li key={c} className="font-mono text-sm text-ink bg-sunken border border-line rounded-lg px-2 py-2 text-center select-all">
            {c}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={copy} className="btn-ghost btn-sm">
          {copied ? <Check size={16} strokeWidth={1.75} aria-hidden /> : <Copy size={16} strokeWidth={1.75} aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" onClick={download} className="btn-ghost btn-sm">
          <Download size={16} strokeWidth={1.75} aria-hidden /> Download .txt
        </button>
        <button type="button" onClick={onDone} className="btn-primary btn-sm sm:ml-auto">
          I saved my codes
        </button>
      </div>
      <p role="status" className="mt-2 text-xs text-ink-muted min-h-[1rem]">
        {copied ? "Codes copied to the clipboard." : copyFailed ? "Copy did not work in this browser. Select the codes and copy them by hand." : ""}
      </p>
    </section>
  );
}
