// Decides whether a Run needs the confirmation dialog, and why.

import type { Risk } from "./risk.ts";

export type ConfirmReason = "risky" | "multi-line" | "first-run" | "every-run";

export interface ConfirmInput {
  risks: readonly Risk[];
  multiLine: boolean;
  /** The user already confirmed a run in this thread. */
  threadConfirmed: boolean;
  /** The "ask before every run" toggle. */
  askEveryRun: boolean;
}

/**
 * The strongest reason to confirm, or null to run straight away.
 * Risky and multi-line commands always confirm; the toggles only cover
 * plain single-line commands.
 */
export function confirmReason({ risks, multiLine, threadConfirmed, askEveryRun }: ConfirmInput): ConfirmReason | null {
  if (risks.length > 0) return "risky";
  if (multiLine) return "multi-line";
  if (!threadConfirmed) return "first-run";
  if (askEveryRun) return "every-run";
  return null;
}
