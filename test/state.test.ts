import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blockKey,
  CONFIRMED_CAP,
  getAskEveryRun,
  hasRan,
  isThreadConfirmed,
  markRan,
  RAN_CAP,
  RAN_KEY,
  setAskEveryRun,
  setThreadConfirmed,
  type KeyValueStore,
} from "../lib/state.ts";

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

test("block key format", () => {
  assert.equal(blockKey("msg_1", "bash", 2), "msg_1#bash#2");
});

test("ran badges persist and do not duplicate", () => {
  const store = memoryStore();
  const key = blockKey("m", "bash", 0);
  assert.equal(hasRan(store, key), false);
  markRan(store, key);
  assert.equal(hasRan(store, key), true);
  markRan(store, key);
  assert.equal(JSON.parse(store.data.get(RAN_KEY)!).length, 1);
});

test("ran badges are capped, oldest dropped", () => {
  const store = memoryStore();
  for (let i = 0; i < RAN_CAP + 25; i++) markRan(store, blockKey("m", "sh", i));
  assert.equal(JSON.parse(store.data.get(RAN_KEY)!).length, RAN_CAP);
  assert.equal(hasRan(store, blockKey("m", "sh", 0)), false);
  assert.equal(hasRan(store, blockKey("m", "sh", RAN_CAP + 24)), true);
});

test("thread confirmation and its cap", () => {
  const store = memoryStore();
  assert.equal(isThreadConfirmed(store, "t1"), false);
  setThreadConfirmed(store, "t1", true);
  assert.equal(isThreadConfirmed(store, "t1"), true);
  setThreadConfirmed(store, "t1", false);
  assert.equal(isThreadConfirmed(store, "t1"), false);
  for (let i = 0; i < CONFIRMED_CAP + 5; i++) setThreadConfirmed(store, `t${i}`, true);
  assert.equal(isThreadConfirmed(store, "t0"), false);
  assert.equal(isThreadConfirmed(store, `t${CONFIRMED_CAP + 4}`), true);
});

test("ask-every-run toggle", () => {
  const store = memoryStore();
  assert.equal(getAskEveryRun(store), false);
  setAskEveryRun(store, true);
  assert.equal(getAskEveryRun(store), true);
  setAskEveryRun(store, false);
  assert.equal(getAskEveryRun(store), false);
});

test("corrupt, missing or blocked storage never throws", () => {
  const store = memoryStore();
  store.data.set(RAN_KEY, "{not json");
  assert.equal(hasRan(store, "x"), false);
  markRan(store, "x");
  assert.equal(hasRan(store, "x"), true);
  assert.equal(hasRan(null, "x"), false);
  markRan(null, "x");
  const throwing: KeyValueStore = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("full");
    },
  };
  assert.equal(getAskEveryRun(throwing), false);
  assert.doesNotThrow(() => setThreadConfirmed(throwing, "t", true));
  assert.doesNotThrow(() => markRan(throwing, "k"));
});
