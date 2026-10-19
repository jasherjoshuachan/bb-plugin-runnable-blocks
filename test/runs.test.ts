import assert from "node:assert/strict";
import { test } from "node:test";
import { formatElapsed, runChip } from "../lib/format.ts";
import { canResume, getRun, RESUME_WINDOW_MS, RUNS_CAP, RUNS_KEY, saveRun, type RunRecord } from "../lib/runs.ts";
import type { KeyValueStore } from "../lib/state.ts";
import { startRecord } from "../lib/watch.ts";

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
}

const rec = (key: string, over: Partial<RunRecord> = {}): RunRecord => ({
  ...startRecord({ key, terminalId: "t", integrated: true, nextSeq: 3, now: 1000 }),
  ...over,
});

test("save, replace and read back a run", () => {
  const store = memoryStore();
  saveRun(store, rec("a"));
  saveRun(store, rec("a", { status: "done", exitCode: 2, preview: "x" }));
  assert.equal(getRun(store, "a")!.exitCode, 2);
  assert.equal(JSON.parse(store.data.get(RUNS_KEY)!).length, 1);
  assert.equal(getRun(store, "missing"), null);
  assert.equal(getRun(null, "a"), null);
});

test("capped to RUNS_CAP records and 4 KB previews", () => {
  const store = memoryStore();
  for (let i = 0; i < RUNS_CAP + 10; i++) saveRun(store, rec(`k${i}`, { preview: "y".repeat(10_000) }));
  const all = JSON.parse(store.data.get(RUNS_KEY)!) as RunRecord[];
  assert.equal(all.length, RUNS_CAP);
  assert.equal(all[0]!.key, "k10");
  assert.equal(all[0]!.preview.length, 4096);
});

test("malformed storage is ignored", () => {
  const store = memoryStore();
  store.setItem(RUNS_KEY, "{not json");
  assert.equal(getRun(store, "a"), null);
  store.setItem(RUNS_KEY, JSON.stringify([{ key: "a", status: "weird" }, rec("b")]));
  assert.equal(getRun(store, "a"), null);
  assert.equal(getRun(store, "b")!.key, "b");
});

test("resume only running records within 30 minutes", () => {
  assert.equal(canResume(rec("a"), 1000 + RESUME_WINDOW_MS - 1), true);
  assert.equal(canResume(rec("a"), 1000 + RESUME_WINDOW_MS), false);
  assert.equal(canResume(rec("a", { status: "done" }), 1001), false);
});

test("chip labels", () => {
  assert.equal(formatElapsed(12_400), "12s");
  assert.equal(formatElapsed(185_000), "3m 05s");
  assert.equal(formatElapsed(3_720_000), "1h 02m");
  assert.equal(runChip(rec("a"), 13_000).label, "Running… 12s");
  assert.deepEqual(
    [0, 1, 127, 130].map((code) => runChip(rec("a", { status: "done", exitCode: code }), 0).label),
    ["✓ 0", "✗ 1", "✗ 127", "✗ 130"],
  );
  assert.match(runChip(rec("a", { status: "done", exitCode: 130 }), 0).description, /interrupted/);
  assert.match(runChip(rec("a", { status: "done", exitCode: 127 }), 0).description, /not found/);
  assert.equal(runChip(rec("a", { status: "done", exitCode: null }), 0).label, "Finished");
  assert.equal(runChip(rec("a", { status: "closed" }), 0).label, "Terminal closed");
  assert.equal(runChip(rec("a", { status: "stopped" }), 0).label, "Stopped watching");
});
