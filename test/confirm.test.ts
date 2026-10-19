import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmReason } from "../lib/confirm.ts";

const risk = [{ id: "sudo", label: "sudo" }];
const base = { risks: [], multiLine: false, threadConfirmed: true, askEveryRun: false };

test("plain single line in a confirmed thread runs straight away", () => {
  assert.equal(confirmReason(base), null);
});

test("first run in a thread confirms", () => {
  assert.equal(confirmReason({ ...base, threadConfirmed: false }), "first-run");
});

test("multi-line always confirms", () => {
  assert.equal(confirmReason({ ...base, multiLine: true }), "multi-line");
});

test("risky always confirms and wins over other reasons", () => {
  assert.equal(confirmReason({ ...base, risks: risk }), "risky");
  assert.equal(confirmReason({ risks: risk, multiLine: true, threadConfirmed: false, askEveryRun: true }), "risky");
});

test("ask-every-run confirms plain commands", () => {
  assert.equal(confirmReason({ ...base, askEveryRun: true }), "every-run");
});
