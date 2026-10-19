// Flags shell commands that deserve an explicit "Run anyway".
//
// This is a speed bump, not a sandbox. It reads the command as text: it does
// not parse quoting, so `echo "rm -rf /"` is flagged too (a false positive we
// accept), and an obfuscated command (`eval "$(printf ...)"`, aliases,
// variables) can slip through. Every run still needs a click.

export interface Risk {
  id: string;
  label: string;
}

/** Splits a command into simple segments on `;`, `&&`, `||`, `|`, `&` and newlines. */
function segments(command: string): string[] {
  return command
    .split(/\|\||&&|[;|&\n]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

/** Whitespace tokens with quote characters dropped (quoting is not parsed). */
function tokens(segment: string): string[] {
  return segment
    .replace(/["'`()]/g, " ")
    .split(/\s+/)
    .filter((token) => token !== "");
}

/** Tokens after the first `name` token in a segment, or null when absent. */
function argsAfter(segment: string, name: string): string[] | null {
  const list = tokens(segment);
  const at = list.findIndex((token) => token === name || token.endsWith(`/${name}`));
  return at === -1 ? null : list.slice(at + 1);
}

function isRecursiveForceRm(segment: string): boolean {
  const args = argsAfter(segment, "rm");
  if (args === null) return false;
  let recursive = false;
  let force = false;
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === "--recursive") recursive = true;
    else if (arg === "--force") force = true;
    else if (/^-[a-zA-Z]+$/.test(arg)) {
      if (/[rR]/.test(arg)) recursive = true;
      if (arg.includes("f")) force = true;
    }
  }
  return recursive && force;
}

function isForcePush(segment: string): boolean {
  const list = tokens(segment);
  const git = list.findIndex((token) => token === "git" || token.endsWith("/git"));
  if (git === -1) return false;
  const push = list.indexOf("push", git + 1);
  if (push === -1) return false;
  return list.slice(push + 1).some(
    (arg) =>
      arg.startsWith("--force") ||
      /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg) ||
      // A `+` refspec force-pushes that ref.
      /^\+[^\s]+$/.test(arg),
  );
}

function isHardReset(segment: string): boolean {
  return /\bgit\b.*\breset\b/.test(segment) && /(^|\s)--hard(\s|$)/.test(segment);
}

function isRecursive777(segment: string): boolean {
  const args = argsAfter(segment, "chmod");
  if (args === null) return false;
  const recursive = args.some((arg) => arg === "--recursive" || /^-[a-zA-Z]*R[a-zA-Z]*$/.test(arg));
  const wideOpen = args.some((arg) => /^0?777$/.test(arg) || /^(a|ugo)\+rwx$/.test(arg));
  return recursive && wideOpen;
}

const SHELLS = "(?:ba|z|da|k|fi|c|tc)?sh";

const PATTERNS: Array<{ id: string; label: string; test: (command: string) => boolean }> = [
  {
    id: "rm-rf",
    label: "Deletes files recursively without asking (rm -rf)",
    test: (command) => segments(command).some(isRecursiveForceRm),
  },
  {
    id: "sudo",
    label: "Runs as administrator (sudo)",
    test: (command) => /(^|[^\w-])(sudo|doas)(\s|$)/m.test(command),
  },
  {
    id: "pipe-to-shell",
    label: "Pipes a downloaded script straight into a shell",
    test: (command) =>
      new RegExp(`\\b(curl|wget|fetch)\\b[^\\n;]*\\|\\s*(sudo\\s+)?(env\\s+\\S+\\s+)?${SHELLS}\\b`).test(command) ||
      new RegExp(`\\b${SHELLS}\\b[^\\n]*(<\\(|\\$\\(|\`)\\s*(curl|wget|fetch)\\b`).test(command),
  },
  {
    id: "mkfs",
    label: "Formats a disk (mkfs)",
    test: (command) => /(^|[^\w-])mkfs(\.\w+)?(\s|$)/m.test(command),
  },
  {
    id: "dd",
    label: "Writes raw data with dd of=",
    test: (command) => segments(command).some((segment) => /(^|\s)dd\s/.test(segment) && /(^|\s)of=/.test(segment)),
  },
  {
    id: "chmod-777",
    label: "Makes files world-writable recursively (chmod -R 777)",
    test: (command) => segments(command).some(isRecursive777),
  },
  {
    id: "git-force-push",
    label: "Force-pushes and can overwrite remote history (git push --force)",
    test: (command) => segments(command).some(isForcePush),
  },
  {
    id: "git-reset-hard",
    label: "Discards uncommitted changes (git reset --hard)",
    test: (command) => segments(command).some(isHardReset),
  },
  {
    id: "fork-bomb",
    label: "Fork bomb",
    test: (command) => /(\w+|:)\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;?\s*\1/.test(command),
  },
  {
    id: "raw-device-write",
    label: "Writes directly to a disk device",
    test: (command) =>
      /(>|\bof=)\s*\/dev\/(sd[a-z]|hd[a-z]|xvd[a-z]|vd[a-z]|nvme\d|mmcblk\d|disk\d|rdisk\d)/.test(command),
  },
];

/** Every risky pattern the command matches, in a stable order. */
export function findRisks(command: string): Risk[] {
  return PATTERNS.filter((pattern) => pattern.test(command)).map(({ id, label }) => ({ id, label }));
}
