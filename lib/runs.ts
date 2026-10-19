// Per-block run records (status chip and output preview), persisted next to
// the "Ran" badges so they survive a reload and a scrolled-away card can
// resume watching where it stopped.

import { PREVIEW_MAX_CHARS } from "./osc133.ts";
import type { KeyValueStore } from "./state.ts";

export const RUNS_KEY = "runnable-blocks:runs";
/** Most run records kept; the oldest are dropped first. */
export const RUNS_CAP = 100;
/** A run older than this is not resumed after a remount or reload. */
export const RESUME_WINDOW_MS = 30 * 60 * 1000;

export type RunStatus =
  /** Waiting for the command to finish. */
  | "running"
  /** Finished; `exitCode` is set when the shell reported one. */
  | "done"
  /** The terminal exited or disconnected before the run finished. */
  | "closed"
  /** Stopped watching (too long, or the output could not be read). */
  | "stopped";

export interface RunRecord {
  key: string;
  terminalId: string;
  /** The terminal has shell integration (exit codes available). */
  integrated: boolean;
  status: RunStatus;
  exitCode: number | null;
  /** Last lines of output, escapes stripped, at most PREVIEW_MAX_CHARS. */
  preview: string;
  startedAt: number;
  finishedAt: number | null;
  /** Next output sequence number to read (`terminals.output({ sinceSeq })`). */
  nextSeq: number;
  /** The parser had seen the run start when this was saved. */
  started: boolean;
  /** Some output was dropped from the terminal's scrollback before it was read. */
  skipped: boolean;
}

function isRecord(value: unknown): value is RunRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.key === "string" &&
    typeof r.terminalId === "string" &&
    typeof r.integrated === "boolean" &&
    (r.status === "running" || r.status === "done" || r.status === "closed" || r.status === "stopped") &&
    (r.exitCode === null || (typeof r.exitCode === "number" && Number.isInteger(r.exitCode))) &&
    typeof r.preview === "string" &&
    typeof r.startedAt === "number" &&
    (r.finishedAt === null || typeof r.finishedAt === "number") &&
    typeof r.nextSeq === "number" &&
    Number.isInteger(r.nextSeq) &&
    r.nextSeq >= 0 &&
    typeof r.started === "boolean" &&
    typeof r.skipped === "boolean"
  );
}

function readAll(store: KeyValueStore | null): RunRecord[] {
  if (store === null) return [];
  try {
    const raw = store.getItem(RUNS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return [];
  }
}

export function getRun(store: KeyValueStore | null, key: string): RunRecord | null {
  return readAll(store).find((record) => record.key === key) ?? null;
}

/** Saves (replaces) the record for its block, newest last, capped. */
export function saveRun(store: KeyValueStore | null, record: RunRecord): void {
  if (store === null) return;
  const safe: RunRecord = { ...record, preview: record.preview.slice(-PREVIEW_MAX_CHARS) };
  const list = readAll(store).filter((item) => item.key !== record.key);
  list.push(safe);
  const capped = list.slice(Math.max(0, list.length - RUNS_CAP));
  try {
    store.setItem(RUNS_KEY, JSON.stringify(capped));
  } catch {
    // Storage full or blocked: the preview is a convenience only.
  }
}

/** True when a stored running record may be resumed now. */
export function canResume(record: RunRecord, now: number): boolean {
  return record.status === "running" && now - record.startedAt < RESUME_WINDOW_MS;
}
