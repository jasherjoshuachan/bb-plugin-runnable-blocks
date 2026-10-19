import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPreview, Osc133Parser, PREVIEW_LINES, PREVIEW_MAX_CHARS, stripAnsi } from "../lib/osc133.ts";

const ESC = "\u001b";
const BEL = "\u0007";
const ST = `${ESC}\\`;
const C = `${ESC}]133;C${BEL}`;
const A = `${ESC}]133;A${BEL}`;
const B = `${ESC}]133;B${BEL}`;
const D = (code: number | string) => `${ESC}]133;D;${code}${BEL}`;

/** A realistic zsh transcript: prompt, echoed command, output, marks. */
function transcript(command: string, output: string, code: number): string {
  return (
    `${A}${ESC}[1;32m%${ESC}[0m ${B}${ESC}[?2004h${command}${ESC}[?2004l\r\r\n${C}` +
    `${output}${ESC}[1m${ESC}[7m%${ESC}[27m${ESC}[1m${ESC}[0m      \r \r${D(code)}`
  );
}

function feedAll(parser: Osc133Parser, parts: readonly string[]) {
  for (const part of parts) parser.feed(part);
  return parser;
}

test("one run: output between C and D, exit code from D", () => {
  const parser = new Osc133Parser();
  parser.feed(transcript("echo hi", "hi\r\n", 0));
  assert.equal(parser.runs.length, 1);
  assert.deepEqual(parser.runs[0], { exitCode: 0, preview: "hi" });
  assert.equal(parser.phase, "idle");
});

test("the echoed command and the prompt are not part of the output", () => {
  const parser = new Osc133Parser();
  parser.feed(transcript("ls -la", "a\r\nb\r\n", 0));
  assert.equal(parser.runs[0]!.preview, "a\nb");
});

test("split at every byte boundary gives the same result", () => {
  const stream =
    transcript("printf", `${ESC}[31mred${ESC}[0m\r\nline2\r\n`, 1) +
    `${ESC}]0;title${ST}` +
    transcript("false", `${ESC}]8;;https://x.test${ST}link${ESC}]8;;${ST}\r\n`, 130);
  const whole = new Osc133Parser();
  whole.feed(stream);
  assert.equal(whole.runs.length, 2);
  assert.deepEqual(whole.runs[0], { exitCode: 1, preview: "red\nline2" });
  assert.deepEqual(whole.runs[1], { exitCode: 130, preview: "link" });
  for (let i = 1; i < stream.length; i++) {
    const parser = feedAll(new Osc133Parser(), [stream.slice(0, i), stream.slice(i)]);
    assert.deepEqual(parser.runs, whole.runs, `split at ${i}`);
  }
  // And one character at a time.
  const single = feedAll(new Osc133Parser(), [...stream]);
  assert.deepEqual(single.runs, whole.runs);
});

test("BEL and ST terminators both work", () => {
  const parser = new Osc133Parser();
  parser.feed(`${ESC}]133;C${ST}out\n${ESC}]133;D;2${ST}`);
  parser.feed(`${ESC}]133;C${BEL}x\n${ESC}]133;D;3${BEL}`);
  assert.deepEqual(
    parser.runs.map((run) => run.exitCode),
    [2, 3],
  );
});

test("8-bit C1 OSC and ST", () => {
  const parser = new Osc133Parser();
  parser.feed("\u009d133;C\u009cok\n\u009d133;D;0\u009c");
  assert.deepEqual(parser.runs[0], { exitCode: 0, preview: "ok" });
});

test("exit codes 0, 1, 127, 130; D without a code; garbage code", () => {
  const parser = new Osc133Parser();
  for (const code of [0, 1, 127, 130]) parser.feed(`${C}x\n${D(code)}`);
  parser.feed(`${C}x\n${ESC}]133;D${BEL}`);
  parser.feed(`${C}x\n${D("abc")}`);
  parser.feed(`${C}x\n${ESC}]133;D;7;aid=12${BEL}`);
  assert.deepEqual(
    parser.runs.map((run) => run.exitCode),
    [0, 1, 127, 130, null, null, 7],
  );
});

test("D before any C is ignored; A and B do nothing", () => {
  const parser = new Osc133Parser();
  parser.feed(`${D(0)}${A}${B}`);
  assert.equal(parser.runs.length, 0);
  assert.equal(parser.phase, "idle");
});

test("missing D: still running, preview of what arrived so far", () => {
  const parser = new Osc133Parser();
  parser.feed(`${C}compiling...\r\nstep 1\r\nstep 2`);
  assert.equal(parser.runs.length, 0);
  assert.equal(parser.phase, "running");
  assert.equal(parser.currentPreview(), "compiling...\nstep 1\nstep 2");
});

test("a second C without D starts over", () => {
  const parser = new Osc133Parser();
  parser.feed(`${C}old\n${C}new\n${D(0)}`);
  assert.deepEqual(parser.runs, [{ exitCode: 0, preview: "new" }]);
});

test("unknown and nested OSC are skipped; text around them kept", () => {
  const parser = new Osc133Parser();
  parser.feed(`${C}a${ESC}]7;file://host/dir${BEL}b${ESC}]1337;Foo=${ESC}]133;D;5${BEL}`);
  // The 1337 OSC was cut short by a new OSC: that one is read normally.
  assert.deepEqual(parser.runs, [{ exitCode: 5, preview: "ab" }]);
});

test("oversize OSC (inline image) is dropped without growing memory", () => {
  const parser = new Osc133Parser();
  parser.feed(`${C}x${ESC}]1337;File=${"A".repeat(100_000)}${BEL}y\n${D(0)}`);
  assert.deepEqual(parser.runs, [{ exitCode: 0, preview: "xy" }]);
});

test("ANSI colors, cursor moves, charset and DCS are stripped", () => {
  assert.equal(stripAnsi(`${ESC}[1;31mERR${ESC}[0m ${ESC}[2K${ESC}(Bok${ESC}P1$r${ST}!`), "ERR ok!");
  assert.equal(stripAnsi(`\u009b31mC1${ESC}[m`), "C1");
});

test("CRLF, lone CR (progress bars), backspace, CR split across chunks", () => {
  assert.equal(stripAnsi("a\r\nb\r\n"), "a\nb");
  assert.equal(stripAnsi("10%\r50%\r100%\ndone"), "100%\ndone");
  assert.equal(stripAnsi("abc\b\bX"), "aX");
  const parser = feedAll(new Osc133Parser(), [C, "one\r", "\ntwo\r", "\n", D(0)]);
  assert.equal(parser.runs[0]!.preview, "one\ntwo");
});

test("preview keeps the last 20 lines and at most 4 KB", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
  const parser = new Osc133Parser();
  parser.feed(`${C}${lines.join("\r\n")}\r\n${D(0)}`);
  const preview = parser.runs[0]!.preview.split("\n");
  assert.equal(preview.length, PREVIEW_LINES);
  assert.equal(preview[0], "line 30");
  assert.equal(preview.at(-1), "line 49");

  const wide = buildPreview(Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(900, "x")));
  assert.ok(wide.length <= PREVIEW_MAX_CHARS);
  assert.ok(wide.endsWith("x"));
});

test("multi-byte text survives", () => {
  const parser = new Osc133Parser();
  parser.feed(`${C}héllo ✓ 日本\n${D(0)}`);
  assert.equal(parser.runs[0]!.preview, "héllo ✓ 日本");
});

test("resume mid-run with seeded lines", () => {
  const parser = new Osc133Parser({ phase: "running", seedLines: ["before"] });
  parser.feed(`after\n${D(1)}`);
  assert.deepEqual(parser.runs, [{ exitCode: 1, preview: "before\nafter" }]);
});

test("paste mode: run between ?2004l and ?2004h, no exit code", () => {
  const parser = new Osc133Parser({ mode: "paste" });
  parser.feed(`${ESC}[?2004h$ echo hi${ESC}[?2004l\r\nhi\r\n${ESC}[?2004h$ `);
  assert.deepEqual(parser.runs, [{ exitCode: null, preview: "hi" }]);
  // OSC 133 marks don't count in paste mode.
  const other = new Osc133Parser({ mode: "paste" });
  other.feed(`${C}x\n${D(0)}`);
  assert.equal(other.runs.length, 0);
});
