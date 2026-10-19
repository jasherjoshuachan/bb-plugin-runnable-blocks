// Turns a fenced code block body into the command the toolbar runs.
//
// Pure and dependency-free so it can be unit tested with `node --test`.

/** Fence languages the plugin claims. */
export const SHELL_LANGUAGES = ["bash", "sh", "zsh", "shell", "console"] as const;

export interface ParsedBlock {
  /** The text to send to a terminal. Empty when there is nothing to run. */
  command: string;
  /** True when the block has a command the toolbar may run or insert. */
  runnable: boolean;
  /** True when the command spans more than one line. */
  multiLine: boolean;
}

const DOLLAR_PROMPT = /^\s*\$(?: |$)/;
const HASH_PROMPT = /^\s*#(?: |$)/;

function normalizeNewlines(code: string): string {
  return code.replace(/\r\n?/g, "\n");
}

/** Drops leading and trailing blank lines and trailing whitespace on the last line. */
export function trimBlock(text: string): string {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (lines.length > 0) lines[lines.length - 1] = lines[lines.length - 1]!.trimEnd();
  return lines.join("\n");
}

function stripPrompt(line: string, prompt: RegExp): string {
  return line.replace(prompt, "");
}

/**
 * Keeps only the prompt lines of a `console` transcript, prompt removed.
 *
 * - `$ ` lines are commands. `# ` lines are commands only when the block has
 *   no `$ ` line at all (a root session); otherwise they are comments.
 * - A line that follows a command ending in `\` is its continuation.
 * - A `> ` line right after a command or continuation is a continuation
 *   prompt (heredocs, open quotes); the `> ` is removed.
 * - Everything else is output and is dropped.
 */
export function stripConsolePrompts(code: string): string {
  const lines = normalizeNewlines(code).split("\n");
  const prompt = lines.some((line) => DOLLAR_PROMPT.test(line)) ? DOLLAR_PROMPT : HASH_PROMPT;
  const kept: string[] = [];
  let inCommand = false;
  let continues = false;
  for (const line of lines) {
    if (prompt.test(line)) {
      const command = stripPrompt(line, prompt);
      kept.push(command);
      inCommand = true;
      continues = command.endsWith("\\");
      continue;
    }
    if (inCommand && continues) {
      kept.push(line);
      continues = line.endsWith("\\");
      continue;
    }
    if (inCommand && /^>(?: |$)/.test(line)) {
      const rest = line.replace(/^> ?/, "");
      kept.push(rest);
      continues = rest.endsWith("\\");
      continue;
    }
    inCommand = false;
    continues = false;
  }
  return trimBlock(kept.join("\n"));
}

/**
 * In a bash/sh/zsh/shell block, strips a `$ ` prompt when every non-blank
 * line has one (agents often write `$ npm test`). Mixed blocks are left as is.
 */
function stripUniformDollarPrompt(code: string): string {
  const lines = code.split("\n");
  const nonBlank = lines.filter((line) => line.trim() !== "");
  if (nonBlank.length === 0) return code;
  if (!nonBlank.every((line) => /^\s*\$ /.test(line))) return code;
  return lines.map((line) => line.replace(/^\s*\$ /, "")).join("\n");
}

export function parseBlock(code: string, language: string): ParsedBlock {
  const lang = language.toLowerCase();
  const normalized = normalizeNewlines(code);
  const command =
    lang === "console"
      ? stripConsolePrompts(normalized)
      : trimBlock(stripUniformDollarPrompt(trimBlock(normalized)));
  return {
    command,
    runnable: command.trim() !== "",
    multiLine: command.includes("\n"),
  };
}
