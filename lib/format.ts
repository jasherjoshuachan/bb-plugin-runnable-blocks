// Labels for the run status chip. Pure, for tests.

import type { RunRecord } from "./runs.ts";

/** "12s", "3m 05s", "1h 02m". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export type ChipTone = "running" | "success" | "failure" | "neutral";

export interface Chip {
  tone: ChipTone;
  /** Visible text. */
  label: string;
  /** Accessible name / tooltip, in words. */
  description: string;
}

export function runChip(record: RunRecord, now: number): Chip {
  switch (record.status) {
    case "running": {
      const elapsed = formatElapsed(now - record.startedAt);
      return { tone: "running", label: `Running… ${elapsed}`, description: `Running for ${elapsed}` };
    }
    case "done":
      if (record.exitCode === null) {
        return {
          tone: "neutral",
          label: "Finished",
          description: "Finished. This terminal's shell doesn't report exit status.",
        };
      }
      return record.exitCode === 0
        ? { tone: "success", label: "✓ 0", description: "Succeeded, exit code 0" }
        : {
            tone: "failure",
            label: `✗ ${record.exitCode}`,
            description: `Failed, exit code ${record.exitCode}${exitHint(record.exitCode)}`,
          };
    case "closed":
      return { tone: "neutral", label: "Terminal closed", description: "The terminal closed before the command finished" };
    case "stopped":
      return {
        tone: "neutral",
        label: "Stopped watching",
        description: "Stopped watching this run; it may still be running in the terminal",
      };
  }
}

function exitHint(code: number): string {
  if (code === 130) return " (interrupted)";
  if (code === 127) return " (command not found)";
  if (code === 126) return " (not executable)";
  return "";
}
