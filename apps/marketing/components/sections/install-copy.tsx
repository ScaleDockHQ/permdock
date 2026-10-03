"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function InstallCopy({ command }: { readonly command: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current) {
        clearTimeout(resetTimer.current);
      }
    };
  }, []);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (resetTimer.current) {
        clearTimeout(resetTimer.current);
      }
      resetTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is unavailable outside a secure context.
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-1.5 font-mono text-sm hover:bg-muted"
    >
      {command}
      {copied ? (
        <CheckIcon aria-hidden="true" className="size-3.5" />
      ) : (
        <CopyIcon aria-hidden="true" className="size-3.5" />
      )}
    </button>
  );
}
