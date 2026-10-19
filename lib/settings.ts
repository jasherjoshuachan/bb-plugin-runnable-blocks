// The plugin's settings: parsing, validation and defaults.
//
// Declared on the server with `bb.settings.define` (validated there with the
// schemas below) and read in the browser with `useSettings`, where every
// value is parsed again defensively: a stored value is untrusted input.

import { SHELL_LANGUAGES } from "./parse.ts";

export type ConfirmMode = "first-run" | "every-run";
export type TerminalMode = "reuse" | "new";

export interface PluginSettingsValues {
  languages: string[];
  confirmMode: ConfirmMode;
  terminalMode: TerminalMode;
  extraRiskyPatterns: RegExp[];
  showOutputPreview: boolean;
  shellIntegration: boolean;
}

export const DEFAULT_LANGUAGES = SHELL_LANGUAGES.join(",");
export const MAX_RISKY_PATTERNS = 20;
export const MAX_RISKY_PATTERN_LENGTH = 200;

export const DEFAULT_SETTINGS: PluginSettingsValues = {
  languages: [...SHELL_LANGUAGES],
  confirmMode: "first-run",
  terminalMode: "reuse",
  extraRiskyPatterns: [],
  showOutputPreview: true,
  shellIntegration: true,
};

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== "");
}

/** An error message for a bad languages value, or null when it's fine. */
export function validateLanguages(value: string): string | null {
  const unknown = splitList(value).filter((item) => !(SHELL_LANGUAGES as readonly string[]).includes(item));
  if (unknown.length > 0) {
    return `Unknown language${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Use any of ${SHELL_LANGUAGES.join(", ")}.`;
  }
  return null;
}

/** The enabled languages, keeping only supported ones, without duplicates. */
export function parseLanguages(value: string): string[] {
  const list = splitList(value).filter((item) => (SHELL_LANGUAGES as readonly string[]).includes(item));
  return [...new Set(list)];
}

/**
 * Splits the comma-separated pattern list. A comma inside a pattern is
 * written `\,` (so `a{1,3}` is `a{1\,3}`).
 */
export function splitPatterns(value: string): string[] {
  const out: string[] = [];
  let current = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "\\" && value[i + 1] === ",") {
      current += ",";
      i++;
    } else if (ch === ",") {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((item) => item.trim()).filter((item) => item !== "");
}

/** An error message for a bad pattern list, or null when every pattern compiles. */
export function validateRiskyPatterns(value: string): string | null {
  const patterns = splitPatterns(value);
  if (patterns.length > MAX_RISKY_PATTERNS) return `At most ${MAX_RISKY_PATTERNS} patterns.`;
  for (const pattern of patterns) {
    if (pattern.length > MAX_RISKY_PATTERN_LENGTH) {
      return `Pattern too long (over ${MAX_RISKY_PATTERN_LENGTH} characters): ${pattern.slice(0, 40)}…`;
    }
    try {
      new RegExp(pattern);
    } catch (cause) {
      return `Not a valid regular expression: ${pattern} (${cause instanceof Error ? cause.message : String(cause)})`;
    }
  }
  return null;
}

/** Compiled patterns; invalid or oversize ones are skipped. */
export function parseRiskyPatterns(value: string): RegExp[] {
  const out: RegExp[] = [];
  for (const pattern of splitPatterns(value).slice(0, MAX_RISKY_PATTERNS)) {
    if (pattern.length > MAX_RISKY_PATTERN_LENGTH) continue;
    try {
      out.push(new RegExp(pattern));
    } catch {
      // skipped; the settings page refuses it anyway
    }
  }
  return out;
}

/** Typed settings from `useSettings().values`, with defaults for anything missing or malformed. */
export function readSettings(values: Record<string, unknown> | undefined): PluginSettingsValues {
  if (values === undefined) return DEFAULT_SETTINGS;
  const str = (key: string): string | undefined => (typeof values[key] === "string" ? (values[key] as string) : undefined);
  const bool = (key: string, fallback: boolean): boolean =>
    typeof values[key] === "boolean" ? (values[key] as boolean) : fallback;
  const languages = str("languages");
  const confirmMode = str("confirmMode");
  const terminalMode = str("terminalMode");
  const patterns = str("extraRiskyPatterns");
  return {
    languages: languages === undefined ? DEFAULT_SETTINGS.languages : parseLanguages(languages),
    confirmMode: confirmMode === "every-run" ? "every-run" : "first-run",
    terminalMode: terminalMode === "new" ? "new" : "reuse",
    extraRiskyPatterns: patterns === undefined ? [] : parseRiskyPatterns(patterns),
    showOutputPreview: bool("showOutputPreview", DEFAULT_SETTINGS.showOutputPreview),
    shellIntegration: bool("shellIntegration", DEFAULT_SETTINGS.shellIntegration),
  };
}
