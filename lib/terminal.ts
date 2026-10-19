// Finds or creates the thread's "Run blocks" terminal and sends commands.
//
// Written against a structural subset of `useSdk().terminals` so it can be
// tested with a fake; the real `TerminalsArea` satisfies it.

import { encodePaste, fromBase64Utf8, pasteModeFromOutput } from "./paste.ts";

export const RUN_TERMINAL_TITLE = "Run blocks";
const INITIAL_COLS = 120;
const INITIAL_ROWS = 30;
const TAIL_BYTES = 4096;

export interface TerminalInfo {
  id: string;
  title: string;
  status: string;
  threadId: string | null;
  hostId: string;
  initialCwd: string;
  updatedAt: number;
}

export interface TerminalOutput {
  chunks: ReadonlyArray<{ dataBase64: string; seq: number }>;
  status: string;
}

export interface TerminalsApi {
  list(args: { scope: { kind: "thread"; threadId: string } }): Promise<{ sessions: readonly TerminalInfo[] }>;
  create(args: {
    cols: number;
    rows: number;
    scope: { kind: "thread"; threadId: string };
    title?: string;
    start?: { mode: "shell" };
  }): Promise<TerminalInfo>;
  input(args: { terminalId: string; dataBase64: string }): Promise<unknown>;
  output(args: { terminalId: string; tailBytes?: number }): Promise<TerminalOutput>;
}

/** True when `value` looks like a usable terminals area (guards older hosts). */
export function isTerminalsApi(value: unknown): value is TerminalsApi {
  if (typeof value !== "object" || value === null) return false;
  const api = value as Record<string, unknown>;
  return (
    typeof api.list === "function" &&
    typeof api.create === "function" &&
    typeof api.input === "function" &&
    typeof api.output === "function"
  );
}

/** Running "Run blocks" terminals of this thread, newest first. */
export function reuseCandidates(sessions: readonly TerminalInfo[], threadId: string): TerminalInfo[] {
  return sessions
    .filter(
      (session) =>
        session.title === RUN_TERMINAL_TITLE &&
        session.status === "running" &&
        (session.threadId === null || session.threadId === threadId),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function readTail(api: TerminalsApi, terminalId: string): Promise<{ text: string; status: string }> {
  const output = await api.output({ terminalId, tailBytes: TAIL_BYTES });
  return { text: output.chunks.map((chunk) => fromBase64Utf8(chunk.dataBase64)).join(""), status: output.status };
}

/**
 * The newest running "Run blocks" terminal whose shell isn't busy, or null.
 * A terminal whose last output turned bracketed paste off is running a
 * command (a dev server, say), so it is skipped rather than typed into.
 */
export async function findReusable(api: TerminalsApi, threadId: string): Promise<TerminalInfo | null> {
  const { sessions } = await api.list({ scope: { kind: "thread", threadId } });
  for (const session of reuseCandidates(sessions, threadId)) {
    let mode: "on" | "off" | "unknown" = "unknown";
    try {
      mode = pasteModeFromOutput((await readTail(api, session.id)).text);
    } catch {
      // Output unavailable: fall back to the spec's "reuse when running".
    }
    if (mode !== "off") return session;
  }
  return null;
}

export function createRunTerminal(api: TerminalsApi, threadId: string): Promise<TerminalInfo> {
  return api.create({
    cols: INITIAL_COLS,
    rows: INITIAL_ROWS,
    scope: { kind: "thread", threadId },
    title: RUN_TERMINAL_TITLE,
    start: { mode: "shell" },
  });
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Waits until a new shell shows its prompt (bracketed paste turned on), so
 * the paste isn't typed into rc-file startup. Returns false on timeout or
 * exit; callers send anyway after a timeout, since some shells never say.
 */
export async function waitForPrompt(
  api: TerminalsApi,
  terminalId: string,
  { timeoutMs = 4000, intervalMs = 150, sleep = defaultSleep, now = Date.now } = {},
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      const tail = await readTail(api, terminalId);
      if (tail.status === "exited" || tail.status === "disconnected") return false;
      if (pasteModeFromOutput(tail.text) === "on") return true;
    } catch {
      // Not readable yet.
    }
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

export interface AcquiredTerminal {
  terminal: TerminalInfo;
  created: boolean;
}

/** The thread's reusable "Run blocks" terminal, or a new one (always new when `fresh`). */
export async function acquireTerminal(
  api: TerminalsApi,
  threadId: string,
  { fresh = false, wait = waitForPrompt }: { fresh?: boolean; wait?: typeof waitForPrompt } = {},
): Promise<AcquiredTerminal> {
  if (!fresh) {
    const reusable = await findReusable(api, threadId);
    if (reusable !== null) return { terminal: reusable, created: false };
  }
  const terminal = await createRunTerminal(api, threadId);
  await wait(api, terminal.id);
  return { terminal, created: true };
}

export async function sendCommand(
  api: TerminalsApi,
  terminalId: string,
  command: string,
  { run }: { run: boolean },
): Promise<void> {
  await api.input({ terminalId, dataBase64: encodePaste(command, { run }) });
}
