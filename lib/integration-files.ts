// Server side of shell integration: writes the wrapper files and finds the
// user's login shell. Node only (imported by server.ts and tests).

import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  BASH_RCFILE,
  bashRcfile,
  integratedArgv,
  type IntegrationPaths,
  shellKind,
  type ShellKind,
  ZSH_DIR,
  zshWrapperFiles,
} from "./integration.ts";

const execFileAsync = promisify(execFile);

/** Writes `content` only when it differs, via a temp file and rename. */
async function writeIfChanged(file: string, content: string): Promise<void> {
  try {
    if ((await readFile(file, "utf8")) === content) return;
  } catch {
    // missing: write it
  }
  await mkdir(dirname(file), { recursive: true, mode: 0o755 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, content, { mode: 0o644 });
  await rename(temp, file);
}

/** Writes every integration file under `root` and returns their paths. */
export async function writeIntegrationFiles(root: string): Promise<IntegrationPaths> {
  const zshDir = join(root, ZSH_DIR);
  const zsh = zshWrapperFiles();
  for (const [name, content] of Object.entries(zsh)) await writeIfChanged(join(zshDir, name), content);
  const bashFile = join(root, BASH_RCFILE);
  await writeIfChanged(bashFile, bashRcfile());
  return { zshDir, bashRcfile: bashFile };
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ShellLookup {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Returns the passwd/Directory Services login shell, or null. */
  loginShell?: () => Promise<string | null>;
  isExecutable?: (file: string) => Promise<boolean>;
}

async function defaultLoginShell(platform: NodeJS.Platform): Promise<string | null> {
  try {
    const info = userInfo();
    if (platform === "darwin") {
      const { stdout } = await execFileAsync("/usr/bin/dscl", [".", "-read", `/Users/${info.username}`, "UserShell"], {
        timeout: 3000,
      });
      const match = /UserShell:\s*(\S+)/.exec(stdout);
      if (match) return match[1]!;
    }
    return info.shell ?? null;
  } catch {
    return null;
  }
}

/**
 * The shell bb's terminals start: $SHELL, else the account's login shell.
 * Null when neither is an absolute, executable path.
 */
export async function detectUserShell({
  env = process.env,
  platform = process.platform,
  loginShell = () => defaultLoginShell(platform),
  isExecutable: canRun = isExecutable,
}: ShellLookup = {}): Promise<string | null> {
  const fromEnv = env.SHELL;
  if (fromEnv !== undefined && fromEnv.startsWith("/") && (await canRun(fromEnv))) return fromEnv;
  const login = await loginShell();
  if (login !== null && login.startsWith("/") && (await canRun(login))) return login;
  return null;
}

export type IntegrationInfo =
  | { available: true; shell: ShellKind; shellPath: string; argv: string[] }
  | { available: false; shell: string | null; reason: string };

/** Everything the frontend needs to start an integrated terminal on this machine. */
export async function prepareIntegration(root: string, lookup: ShellLookup = {}): Promise<IntegrationInfo> {
  const shellPath = await detectUserShell(lookup);
  if (shellPath === null) return { available: false, shell: null, reason: "Couldn't find your login shell." };
  const kind = shellKind(shellPath);
  if (kind === null) {
    return {
      available: false,
      shell: shellPath,
      reason: "Exit status needs zsh or bash; this shell runs commands without it.",
    };
  }
  const paths = await writeIntegrationFiles(root);
  return { available: true, shell: kind, shellPath, argv: integratedArgv(kind, shellPath, paths) };
}
