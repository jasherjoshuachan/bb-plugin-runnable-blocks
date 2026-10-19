import assert from "node:assert/strict";
import { test } from "node:test";
import { toBase64Utf8 } from "../lib/paste.ts";
import type { RunRecord } from "../lib/runs.ts";
import type { TerminalOutput, TerminalsApi } from "../lib/terminal.ts";
import { currentSeq, pollDelay, startRecord, watchRun } from "../lib/watch.ts";

const ESC = "\u001b";
const C = `${ESC}]133;C\u0007`;
const D = (code: number) => `${ESC}]133;D;${code}\u0007`;

/** A fake terminal whose scrollback grows by one scripted chunk per poll. */
function scripted(chunks: string[], { status = "running", splitBytes = false } = {}) {
  const scrollback: Array<{ seq: number; dataBase64: string }> = [];
  let polls = 0;
  const requests: Array<number | undefined> = [];
  let currentStatus = status;
  const api: TerminalsApi = {
    list: async () => ({ sessions: [] }),
    create: async () => {
      throw new Error("unused");
    },
    input: async () => ({}),
    output: async ({ sinceSeq, limitChunks }): Promise<TerminalOutput> => {
      if (limitChunks === 1) return { chunks: [], nextSeq: scrollback.length, truncated: false, status: currentStatus };
      requests.push(sinceSeq);
      const next = chunks[polls++];
      if (next !== undefined) {
        if (splitBytes) {
          // Split the UTF-8 bytes mid-character to exercise streaming decode.
          const bytes = new TextEncoder().encode(next);
          const half = Math.max(1, Math.floor(bytes.length / 2) | 1);
          for (const part of [bytes.slice(0, half), bytes.slice(half)]) {
            scrollback.push({ seq: scrollback.length, dataBase64: btoa(String.fromCharCode(...part)) });
          }
        } else scrollback.push({ seq: scrollback.length, dataBase64: toBase64Utf8(next) });
      }
      const from = sinceSeq ?? 0;
      return {
        chunks: scrollback.filter((chunk) => chunk.seq >= from),
        nextSeq: scrollback.length,
        truncated: false,
        status: currentStatus,
      };
    },
  };
  return { api, requests, setStatus: (s: string) => (currentStatus = s) };
}

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
  ...startRecord({ key: "m#bash#0", terminalId: "t1", integrated: true, nextSeq: 0, now: 0 }),
  ...over,
});

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

test("watches a run to D and reports exit code and preview", async () => {
  const { api, requests } = scripted([`echo hi${ESC}[?2004l\r\n`, `${C}hi\r\n`, "", `${D(0)}${ESC}]133;A\u0007`]);
  const updates: RunRecord[] = [];
  const result = await watchRun(api, record(), { ...clock(), onUpdate: (r) => updates.push(r) });
  assert.equal(result.status, "done");
  assert.equal(result.exitCode, 0);
  assert.equal(result.preview, "hi");
  assert.equal(result.nextSeq, 4);
  // sinceSeq advances with nextSeq.
  assert.deepEqual(requests, [0, 1, 2, 3]);
  assert.ok(updates.some((u) => u.status === "running" && u.started));
});

test("non-zero exit, split UTF-8 bytes", async () => {
  const { api } = scripted([`${C}héllo ✓\r\n`, D(130)], { splitBytes: true });
  const result = await watchRun(api, record(), clock());
  assert.equal(result.exitCode, 130);
  assert.equal(result.preview, "héllo ✓");
});

test("fallback without integration: paste-mode run, no exit code", async () => {
  const { api } = scripted([`ls${ESC}[?2004l\r\n`, "a b\r\n", `${ESC}[?2004h$ `]);
  const result = await watchRun(api, record({ integrated: false }), clock());
  assert.equal(result.status, "done");
  assert.equal(result.exitCode, null);
  assert.equal(result.preview, "a b");
});

test("long run: stays running, then stops watching after the window", async () => {
  const { api } = scripted([`${C}building\r\n`]);
  const c = clock();
  const seen: string[] = [];
  const result = await watchRun(api, record(), { ...c, maxWatchMs: 10_000, onUpdate: (r) => seen.push(r.status) });
  assert.equal(result.status, "stopped");
  assert.equal(result.preview, "building");
  assert.equal(seen[0], "running");
});

test("terminal exit ends the watch as closed", async () => {
  const fake = scripted([`${C}x\r\n`]);
  fake.setStatus("exited");
  const result = await watchRun(fake.api, record(), clock());
  assert.equal(result.status, "closed");
});

test("abort (card unmounted) stops polling; resume picks up from the saved seq", async () => {
  const fake = scripted([`${C}one\r\n`, "two\r\n", D(1)]);
  const controller = new AbortController();
  let saved: RunRecord | null = null;
  await watchRun(fake.api, record(), {
    ...clock(),
    signal: controller.signal,
    onUpdate: (r) => {
      saved = r;
      controller.abort();
    },
  });
  assert.ok(saved !== null);
  const paused: RunRecord = saved;
  assert.equal(paused.status, "running");
  assert.equal(paused.started, true);
  assert.equal(paused.nextSeq, 1);
  const resumed = await watchRun(fake.api, paused, clock());
  assert.equal(resumed.status, "done");
  assert.equal(resumed.exitCode, 1);
  assert.equal(resumed.preview, "one\ntwo");
});

test("read failures: retried, then stopped", async () => {
  let calls = 0;
  const api = scripted([]).api;
  api.output = async () => {
    calls++;
    throw new Error("offline");
  };
  const result = await watchRun(api, record(), clock());
  assert.equal(result.status, "stopped");
  assert.equal(calls, 5);
});

test("truncated scrollback is flagged", async () => {
  const api = scripted([]).api;
  api.output = async () => ({
    chunks: [{ seq: 9, dataBase64: toBase64Utf8(`${C}late\r\n${D(0)}`) }],
    nextSeq: 10,
    truncated: true,
    status: "running",
  });
  const result = await watchRun(api, record({ nextSeq: 2 }), clock());
  assert.equal(result.skipped, true);
  assert.equal(result.exitCode, 0);
});

test("currentSeq reads nextSeq; poll delay backs off", async () => {
  const fake = scripted([]);
  assert.equal(await currentSeq(fake.api, "t1"), 0);
  assert.equal(pollDelay(0), 250);
  assert.equal(pollDelay(10_000), 1000);
  assert.equal(pollDelay(120_000), 3000);
});
