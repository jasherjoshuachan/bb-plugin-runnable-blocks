import assert from "node:assert/strict";
import { test } from "node:test";
import { fromBase64Utf8, toBase64Utf8 } from "../lib/paste.ts";
import {
  acquireTerminal,
  INTEGRATED_PROMPT_TIMEOUT_MS,
  isTerminalsApi,
  RUN_TERMINAL_TITLE,
  reuseCandidates,
  sendCommand,
  waitForPrompt,
  type TerminalInfo,
  type TerminalsApi,
} from "../lib/terminal.ts";

const ESC = "\u001b";

function session(over: Partial<TerminalInfo>): TerminalInfo {
  return {
    id: "t1",
    title: RUN_TERMINAL_TITLE,
    status: "running",
    threadId: "th",
    hostId: "h1",
    initialCwd: "/work",
    updatedAt: 1,
    ...over,
  };
}

function fakeApi(sessions: TerminalInfo[], tails: Record<string, string> = {}) {
  const calls = { created: [] as unknown[], inputs: [] as Array<{ terminalId: string; data: string }> };
  const api: TerminalsApi = {
    list: async () => ({ sessions }),
    create: async (args) => {
      calls.created.push(args);
      const created = session({ id: `new${calls.created.length}`, updatedAt: 99 });
      tails[created.id] = `${ESC}[?2004h% `;
      return created;
    },
    input: async ({ terminalId, dataBase64 }) => {
      calls.inputs.push({ terminalId, data: fromBase64Utf8(dataBase64) });
      return {};
    },
    output: async ({ terminalId }) => ({
      chunks: [{ dataBase64: toBase64Utf8(tails[terminalId] ?? ""), seq: 1 }],
      status: "running", nextSeq: 0, truncated: false,
    }),
  };
  return { api, calls };
}

const noWait = async () => true;

test("isTerminalsApi guards missing APIs", () => {
  assert.equal(isTerminalsApi(undefined), false);
  assert.equal(isTerminalsApi({ list() {} }), false);
  assert.equal(isTerminalsApi(fakeApi([]).api), true);
});

test("reuse candidates: title, running, thread, newest first", () => {
  const list = reuseCandidates(
    [
      session({ id: "old", updatedAt: 1 }),
      session({ id: "new", updatedAt: 5 }),
      session({ id: "other-title", title: "pnpm dev" }),
      session({ id: "exited", status: "exited" }),
      session({ id: "other-thread", threadId: "x" }),
    ],
    "th",
  );
  assert.deepEqual(
    list.map((s) => s.id),
    ["new", "old"],
  );
});

test("reuses an idle Run blocks terminal", async () => {
  const { api, calls } = fakeApi([session({ id: "idle" })], { idle: `${ESC}[?2004h$ ` });
  const got = await acquireTerminal(api, "th", { wait: noWait });
  assert.equal(got.terminal.id, "idle");
  assert.equal(got.created, false);
  assert.equal(calls.created.length, 0);
});

test("reuses when the shell's mode is unknown", async () => {
  const { api } = fakeApi([session({ id: "quiet" })], { quiet: "" });
  assert.equal((await acquireTerminal(api, "th", { wait: noWait })).terminal.id, "quiet");
});

test("skips a busy terminal and creates a new one", async () => {
  const { api, calls } = fakeApi([session({ id: "busy" })], {
    busy: `${ESC}[?2004h$ npm run dev\n${ESC}[?2004l\nlistening`,
  });
  const got = await acquireTerminal(api, "th", { wait: noWait });
  assert.equal(got.created, true);
  assert.equal(calls.created.length, 1);
  assert.deepEqual(calls.created[0], {
    cols: 120,
    rows: 30,
    scope: { kind: "thread", threadId: "th" },
    title: RUN_TERMINAL_TITLE,
    start: { mode: "shell" },
  });
});

test("creates one when none exists", async () => {
  const { api } = fakeApi([]);
  assert.equal((await acquireTerminal(api, "th", { wait: noWait })).created, true);
});

test("fresh always creates", async () => {
  const { api, calls } = fakeApi([session({ id: "idle" })], { idle: `${ESC}[?2004h$ ` });
  const got = await acquireTerminal(api, "th", { fresh: true, wait: noWait });
  assert.equal(got.created, true);
  assert.equal(calls.created.length, 1);
});

test("waitForPrompt resolves once bracketed paste turns on", async () => {
  let reads = 0;
  const api = fakeApi([]).api;
  api.output = async () => {
    reads++;
    return {
      chunks: [{ dataBase64: toBase64Utf8(reads >= 3 ? `${ESC}[?2004h% ` : "loading"), seq: reads }],
      status: "running", nextSeq: 0, truncated: false,
    };
  };
  assert.equal(await waitForPrompt(api, "t", { sleep: async () => {} }), true);
  assert.equal(reads, 3);
});

test("waitForPrompt gives up on timeout and on exit", async () => {
  const api = fakeApi([]).api;
  let t = 0;
  api.output = async () => ({ chunks: [], status: "running", nextSeq: 0, truncated: false });
  assert.equal(
    await waitForPrompt(api, "t", { timeoutMs: 100, sleep: async (ms) => void (t += ms), now: () => t }),
    false,
  );
  api.output = async () => ({ chunks: [], status: "exited", nextSeq: 0, truncated: false });
  assert.equal(await waitForPrompt(api, "t", { sleep: async () => {} }), false);
});

test("sendCommand writes a sanitized bracketed paste", async () => {
  const { api, calls } = fakeApi([]);
  await sendCommand(api, "t1", `echo ok${ESC}[201~whoami`, { run: true });
  assert.deepEqual(calls.inputs, [{ terminalId: "t1", data: `${ESC}[200~echo okwhoami${ESC}[201~\r` }]);
  await sendCommand(api, "t1", "ls", { run: false });
  assert.equal(calls.inputs[1]!.data, `${ESC}[200~ls${ESC}[201~`);
});

const ARGV = ["/bin/sh", "-c", "launcher", "runnable-blocks", "/data dir/zsh", "/bin/zsh"];
const INTEGRATED_PROMPT = `${ESC}]133;D;0\u0007${ESC}]133;A\u0007% ${ESC}]133;B\u0007${ESC}[?2004h`;

test("with integration: a v0.1 terminal (no marks) is not reused; the new one starts with argv", async () => {
  const { api, calls } = fakeApi([session({ id: "old" })], { old: `${ESC}[?2004h% ` });
  const got = await acquireTerminal(api, "th", { integrationArgv: ARGV, wait: noWait });
  assert.equal(got.created, true);
  assert.deepEqual((calls.created[0] as { start: unknown }).start, { mode: "argv", argv: ARGV });
  assert.equal((calls.created[0] as { title: string }).title, RUN_TERMINAL_TITLE);
});

test("with integration: an idle integrated terminal is reused and reported integrated", async () => {
  const { api, calls } = fakeApi([session({ id: "int" })], { int: INTEGRATED_PROMPT });
  const got = await acquireTerminal(api, "th", { integrationArgv: ARGV, wait: noWait });
  assert.equal(got.terminal.id, "int");
  assert.equal(got.integrated, true);
  assert.equal(calls.created.length, 0);
});

test("a terminal created with the integration argv counts as integrated and is remembered", async () => {
  const { api } = fakeApi([]);
  const remembered: string[] = [];
  const waits: Array<number | undefined> = [];
  const got = await acquireTerminal(api, "th", {
    integrationArgv: ARGV,
    wait: async (_api, _id, options) => {
      waits.push(options?.timeoutMs);
      return true;
    },
    rememberIntegrated: (id) => remembered.push(id),
  });
  assert.equal(got.integrated, true);
  assert.deepEqual(remembered, [got.terminal.id]);
  // A login shell can take seconds to start: the long timeout is used.
  assert.deepEqual(waits, [INTEGRATED_PROMPT_TIMEOUT_MS]);
});

test("regression: a still-starting integrated terminal is reused (and waited for), not duplicated", async () => {
  // No output yet: the shell is still running its login files.
  const { api, calls } = fakeApi([session({ id: "starting" })], { starting: "" });
  const waited: string[] = [];
  const got = await acquireTerminal(api, "th", {
    integrationArgv: ARGV,
    knownIntegrated: (id) => id === "starting",
    wait: async (_api, id) => {
      waited.push(id);
      return true;
    },
  });
  assert.equal(got.terminal.id, "starting");
  assert.equal(got.integrated, true);
  assert.equal(calls.created.length, 0);
  assert.deepEqual(waited, ["starting"]);
  // An idle one with marks is reused without waiting.
  const idle = fakeApi([session({ id: "idle" })], { idle: INTEGRATED_PROMPT });
  const noWaits: string[] = [];
  await acquireTerminal(idle.api, "th", { integrationArgv: ARGV, wait: async (_a, id) => (noWaits.push(id), true) });
  assert.deepEqual(noWaits, []);
});

test("waitForPrompt slows its polling after 3 seconds", async () => {
  const api = fakeApi([]).api;
  api.output = async () => ({ chunks: [], status: "running", nextSeq: 0, truncated: false });
  let t = 0;
  const gaps: number[] = [];
  await waitForPrompt(api, "t", {
    timeoutMs: 5000,
    sleep: async (ms) => {
      gaps.push(ms);
      t += ms;
    },
    now: () => t,
  });
  assert.equal(gaps[0], 150);
  assert.equal(gaps.at(-1), 400);
});

test("without integration: v0.1 behavior (shell start, any idle terminal reused)", async () => {
  const { api, calls } = fakeApi([session({ id: "int" })], { int: INTEGRATED_PROMPT });
  const got = await acquireTerminal(api, "th", { wait: noWait });
  assert.equal(got.terminal.id, "int");
  const fresh = await acquireTerminal(api, "th", { fresh: true, wait: noWait });
  assert.equal(fresh.integrated, false);
  assert.deepEqual((calls.created[0] as { start: unknown }).start, { mode: "shell" });
});
