// Follows one run in a terminal: polls `terminals.output({ sinceSeq })`,
// feeds the bytes to the OSC 133 parser (or the bracketed-paste fallback),
// and reports a RunRecord until the run ends, the terminal closes, the
// watch window passes, or the caller aborts (the block's card unmounted).

import { Osc133Parser } from "./osc133.ts";
import { RESUME_WINDOW_MS, type RunRecord } from "./runs.ts";
import type { TerminalsApi } from "./terminal.ts";

export interface WatchOptions {
  onUpdate?: (record: RunRecord) => void;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Stop watching a run this long after it started. */
  maxWatchMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const MAX_READ_FAILURES = 5;

/** Poll gap: quick at first, slower for long runs. */
export function pollDelay(elapsedMs: number): number {
  if (elapsedMs < 5_000) return 250;
  if (elapsedMs < 60_000) return 1_000;
  return 3_000;
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A new record for a run whose output starts at `nextSeq`. */
export function startRecord(args: {
  key: string;
  terminalId: string;
  integrated: boolean;
  nextSeq: number;
  now: number;
}): RunRecord {
  return {
    key: args.key,
    terminalId: args.terminalId,
    integrated: args.integrated,
    status: "running",
    exitCode: null,
    preview: "",
    startedAt: args.now,
    finishedAt: null,
    nextSeq: args.nextSeq,
    started: false,
    skipped: false,
  };
}

/** The output position before a run: send input only after reading this. */
export async function currentSeq(api: TerminalsApi, terminalId: string): Promise<number> {
  const output = await api.output({ terminalId, limitChunks: 1, tailBytes: 1 });
  return output.nextSeq;
}

/** Watches `record` (status "running") to the end. Resolves with the last record. */
export async function watchRun(api: TerminalsApi, record: RunRecord, options: WatchOptions = {}): Promise<RunRecord> {
  const { onUpdate, signal, sleep = defaultSleep, now = Date.now, maxWatchMs = RESUME_WINDOW_MS } = options;
  const parser = new Osc133Parser({
    // OSC 133 when the shell prints marks, else the bracketed-paste fallback.
    mode: "auto",
    sawMarks: record.integrated && record.started,
    phase: record.started ? "running" : "idle",
    seedLines: record.preview === "" ? [] : record.preview.split("\n"),
  });
  const decoder = new TextDecoder();
  let current = record;
  let failures = 0;
  let lastPreview = record.preview;

  const update = (next: RunRecord) => {
    current = next;
    onUpdate?.(next);
    return next;
  };

  while (current.status === "running") {
    if (signal?.aborted) return current;
    if (now() - current.startedAt >= maxWatchMs) {
      return update({ ...current, status: "stopped", finishedAt: now() });
    }
    let output: Awaited<ReturnType<TerminalsApi["output"]>>;
    try {
      output = await api.output({ terminalId: current.terminalId, sinceSeq: current.nextSeq });
      failures = 0;
    } catch {
      if (++failures >= MAX_READ_FAILURES) return update({ ...current, status: "stopped", finishedAt: now() });
      await sleep(pollDelay(now() - current.startedAt));
      continue;
    }
    if (signal?.aborted) return current;

    const cursor = current.nextSeq;
    const chunks = [...output.chunks].filter((chunk) => chunk.seq >= cursor).sort((a, b) => a.seq - b.seq);
    // The scrollback no longer holds everything since `cursor`.
    const skipped = current.skipped || output.truncated || (chunks.length > 0 && chunks[0]!.seq > cursor);
    for (const chunk of chunks) parser.feed(decoder.decode(decodeBase64(chunk.dataBase64), { stream: true }));
    const nextSeq = Math.max(cursor, output.nextSeq);

    const run = parser.runs[0];
    if (run !== undefined) {
      return update({
        ...current,
        integrated: parser.hasMarks,
        status: "done",
        exitCode: run.exitCode,
        preview: run.preview,
        finishedAt: now(),
        nextSeq,
        started: true,
        skipped,
      });
    }
    const preview = parser.phase === "running" ? parser.currentPreview() : "";
    const ended = output.status === "exited" || output.status === "disconnected";
    if (ended) {
      return update({
        ...current,
        status: "closed",
        exitCode: null,
        preview,
        finishedAt: now(),
        nextSeq,
        started: parser.phase === "running",
        skipped,
      });
    }
    if (
      preview !== lastPreview ||
      nextSeq !== current.nextSeq ||
      skipped !== current.skipped ||
      (parser.phase === "running") !== current.started
    ) {
      lastPreview = preview;
      update({
        ...current,
        integrated: current.integrated || parser.hasMarks,
        preview,
        nextSeq,
        started: parser.phase === "running",
        skipped,
      });
    }
    await sleep(pollDelay(now() - current.startedAt));
  }
  return current;
}
