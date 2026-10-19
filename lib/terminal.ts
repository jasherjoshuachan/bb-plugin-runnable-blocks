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
  /** Sequence number of the next chunk (read from here with `sinceSeq`). */
  nextSeq: number;
  /** The scrollback no longer holds everything asked for. */
  truncated: boolean;
  status: string;
}

/** How a terminal starts: the user's shell, or an explicit argv (never a command string). */
export type TerminalStart = { mode: "shell" } | { mode: "argv"; argv: string[] };

export interface TerminalsApi {
  list(args: { scope: { kind: "thread"; threadId: string } }): Promise<{ sessions: readonly TerminalInfo[] }>;
  create(args: {
    cols: number;
    rows: number;
    scope: { kind: "thread"; threadId: string };
    title?: string;
    start?: TerminalStart;
  }): Promise<TerminalInfo>;
  input(args: { terminalId: string; dataBase64: string }): Promise<unknown>;
  output(args: { terminalId: string; tailBytes?: number; sinceSeq?: number; limitChunks?: number }): Promise<TerminalOutput>;
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

const OSC_133 = "\u001b]133;";

/**
 * True when recent output carries OSC 133 marks, i.e. the shell was started
 * with the plugin's integration. An integrated shell prints an A mark at
 * every prompt, so an idle one always has one in its last few KB.
 */
export function hasIntegrationMarks(output: string): boolean {
  return output.includes(OSC_133);
}

/** Longest wait for a new integrated shell's first prompt (login startup files can be slow). */
export const INTEGRATED_PROMPT_TIMEOUT_MS = 30_000;

export interface ReuseOptions {
  /** Only reuse terminals with shell integration (v0.1 terminals are skipped). */
  requireIntegration?: boolean;
  /**
   * Terminals this plugin started with integration. One that is still
   * loading its startup files has printed no marks yet but is integrated.
   */
  knownIntegrated?: (terminalId: string) => boolean;
}

export interface ReusableTerminal {
  terminal: TerminalInfo;
  integrated: boolean;
  /** Its shell showed a prompt (bracketed paste on). False while it is still starting. */
  ready: boolean;
}

/**
 * The newest running "Run blocks" terminal whose shell isn't busy, or null.
 * A terminal whose last output turned bracketed paste off is running a
 * command (a dev server, say), so it is skipped rather than typed into.
 */
export async function findReusableTerminal(
  api: TerminalsApi,
  threadId: string,
  { requireIntegration = false, knownIntegrated = () => false }: ReuseOptions = {},
): Promise<ReusableTerminal | null> {
  const { sessions } = await api.list({ scope: { kind: "thread", threadId } });
  for (const session of reuseCandidates(sessions, threadId)) {
    let mode: "on" | "off" | "unknown" = "unknown";
    let integrated = false;
    try {
      const tail = (await readTail(api, session.id)).text;
      mode = pasteModeFromOutput(tail);
      integrated = hasIntegrationMarks(tail);
    } catch {
      // Output unavailable: fall back to v0.1's "reuse when running".
    }
    if (mode === "off") continue;
    integrated ||= knownIntegrated(session.id);
    if (requireIntegration && !integrated) continue;
    return { terminal: session, integrated, ready: mode === "on" };
  }
  return null;
}

/** v0.1 signature: the reusable terminal itself. */
export async function findReusable(
  api: TerminalsApi,
  threadId: string,
  options: ReuseOptions = {},
): Promise<TerminalInfo | null> {
  return (await findReusableTerminal(api, threadId, options))?.terminal ?? null;
}

/** Creates a "Run blocks" terminal: the integrated argv when given, else the plain shell. */
export function createRunTerminal(
  api: TerminalsApi,
  threadId: string,
  argv: readonly string[] | null = null,
): Promise<TerminalInfo> {
  return api.create({
    cols: INITIAL_COLS,
    rows: INITIAL_ROWS,
    scope: { kind: "thread", threadId },
    title: RUN_TERMINAL_TITLE,
    start: argv === null ? { mode: "shell" } : { mode: "argv", argv: [...argv] },
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
  const started = now();
  const deadline = started + timeoutMs;
  for (;;) {
    try {
      const tail = await readTail(api, terminalId);
      if (tail.status === "exited" || tail.status === "disconnected") return false;
      if (pasteModeFromOutput(tail.text) === "on") return true;
    } catch {
      // Not readable yet.
    }
    if (now() >= deadline) return false;
    // Slower polling once a startup is clearly taking a while.
    await sleep(now() - started > 3000 ? Math.max(intervalMs, 400) : intervalMs);
  }
}

export interface AcquiredTerminal {
  terminal: TerminalInfo;
  created: boolean;
  /** The terminal has shell integration, so runs report an exit code. */
  integrated: boolean;
}

export interface AcquireOptions {
  /** Always create a new terminal. */
  fresh?: boolean;
  /**
   * The integrated shell's argv, or null for none. With an argv, only
   * integrated terminals are reused and new ones start with it.
   */
  integrationArgv?: readonly string[] | null;
  wait?: typeof waitForPrompt;
  knownIntegrated?: (terminalId: string) => boolean;
  /** Called with the id of every terminal created with the integration argv. */
  rememberIntegrated?: (terminalId: string) => void;
}

/** The thread's reusable "Run blocks" terminal, or a new one (always new when `fresh`). */
export async function acquireTerminal(
  api: TerminalsApi,
  threadId: string,
  {
    fresh = false,
    integrationArgv = null,
    wait = waitForPrompt,
    knownIntegrated = () => false,
    rememberIntegrated = () => {},
  }: AcquireOptions = {},
): Promise<AcquiredTerminal> {
  const wantIntegration = integrationArgv !== null;
  if (!fresh) {
    const reusable = await findReusableTerminal(api, threadId, { requireIntegration: wantIntegration, knownIntegrated });
    if (reusable !== null) {
      // An integrated terminal that is still starting: don't type ahead into
      // its startup files, wait for its prompt like a new one.
      if (!reusable.ready && reusable.integrated) {
        await wait(api, reusable.terminal.id, { timeoutMs: INTEGRATED_PROMPT_TIMEOUT_MS });
      }
      return { terminal: reusable.terminal, created: false, integrated: reusable.integrated };
    }
  }
  const terminal = await createRunTerminal(api, threadId, integrationArgv);
  if (wantIntegration) rememberIntegrated(terminal.id);
  // The integrated launcher goes through `$SHELL -lc`, which runs the login
  // startup files first; those can take several seconds.
  await wait(api, terminal.id, wantIntegration ? { timeoutMs: INTEGRATED_PROMPT_TIMEOUT_MS } : {});
  // Started with the integration argv: integrated, even if its marks haven't
  // shown yet. The watcher falls back by itself if they never do.
  return { terminal, created: true, integrated: wantIntegration };
}

export async function sendCommand(
  api: TerminalsApi,
  terminalId: string,
  command: string,
  { run }: { run: boolean },
): Promise<void> {
  await api.input({ terminalId, dataBase64: encodePaste(command, { run }) });
}
