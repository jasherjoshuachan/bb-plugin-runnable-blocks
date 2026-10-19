import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPaste,
  encodePaste,
  fromBase64Utf8,
  PASTE_END,
  PASTE_START,
  pasteModeFromOutput,
  sanitizePayload,
  toBase64Utf8,
} from "../lib/paste.ts";

const ESC = "\u001b";

test("run wraps in bracketed paste and presses Enter", () => {
  assert.equal(buildPaste("npm test", { run: true }), `${ESC}[200~npm test${ESC}[201~\r`);
});

test("insert wraps in bracketed paste without Enter", () => {
  const out = buildPaste("npm test", { run: false });
  assert.equal(out, `${ESC}[200~npm test${ESC}[201~`);
  assert.ok(!out.includes("\r"));
  assert.ok(!out.includes("\n"));
});

test("multi-line payload keeps newlines inside one paste", () => {
  const out = buildPaste("cat <<'EOF'\na\nEOF", { run: true });
  assert.equal(out, `${PASTE_START}cat <<'EOF'\na\nEOF${PASTE_END}\r`);
});

test("CRLF and CR inside the payload become LF, so nothing submits early", () => {
  assert.equal(sanitizePayload("a\r\nb\rc"), "a\nb\nc");
});

test("SECURITY: an embedded paste-end cannot escape the paste", () => {
  const hostile = `echo safe${ESC}[201~rm -rf ~\r`;
  const out = buildPaste(hostile, { run: false });
  // Exactly one paste end, at the very end; no carriage return anywhere.
  assert.equal(out.split(PASTE_END).length - 1, 1);
  assert.ok(out.endsWith(PASTE_END));
  assert.ok(!out.includes("\r"));
  assert.equal(out, `${PASTE_START}echo saferm -rf ~\n${PASTE_END}`);
});

test("SECURITY: nested delimiters rebuilt by removal are removed too", () => {
  const hostile = `a${ESC}[20${ESC}[201~1~b${ESC}${ESC}[200~[201~c`;
  const out = sanitizePayload(hostile);
  assert.ok(!out.includes(ESC));
  assert.ok(!out.includes(PASTE_END));
  assert.ok(!out.includes(PASTE_START));
  const wrapped = buildPaste(hostile, { run: true });
  assert.equal(wrapped.split(PASTE_END).length - 1, 1);
  assert.ok(wrapped.endsWith(`${PASTE_END}\r`));
});

test("SECURITY: paste-start inside the payload is removed", () => {
  assert.equal(sanitizePayload(`x${ESC}[200~y`), "xy");
});

test("SECURITY: control characters are stripped, tab and newline kept", () => {
  assert.equal(sanitizePayload("a\u0003b\u0004c\u0007d\u007fe\tf\ng"), "abcde\tf\ng");
  // 8-bit CSI (U+009B) and OSC (U+009D)
  assert.equal(sanitizePayload("a\u009b201~b\u009dc"), "a201~bc");
  // A bare ESC that starts some other sequence
  assert.equal(sanitizePayload(`a${ESC}]0;title\u0007b`), "a]0;titleb");
});

test("non-ASCII text survives sanitizing", () => {
  assert.equal(sanitizePayload("echo héllo 日本語 🚀"), "echo héllo 日本語 🚀");
});

test("base64 encodes UTF-8 including non-ASCII", () => {
  assert.equal(toBase64Utf8("hi"), "aGk=");
  for (const text of ["echo héllo", "echo 日本語 🚀", "printf '\\u00e9'", ""]) {
    assert.equal(fromBase64Utf8(toBase64Utf8(text)), text);
    assert.equal(toBase64Utf8(text), Buffer.from(text, "utf8").toString("base64"));
  }
});

test("base64 handles large payloads", () => {
  const big = "é".repeat(100_000);
  assert.equal(toBase64Utf8(big), Buffer.from(big, "utf8").toString("base64"));
});

test("encodePaste is base64 of buildPaste", () => {
  const command = "echo ünïcode";
  assert.equal(fromBase64Utf8(encodePaste(command, { run: true })), buildPaste(command, { run: true }));
});

test("paste mode from output", () => {
  assert.equal(pasteModeFromOutput(""), "unknown");
  assert.equal(pasteModeFromOutput("plain output"), "unknown");
  assert.equal(pasteModeFromOutput(`${ESC}[?2004h% `), "on");
  assert.equal(pasteModeFromOutput(`${ESC}[?2004h% npm run dev\n${ESC}[?2004l\nready`), "off");
  assert.equal(pasteModeFromOutput(`${ESC}[?2004l\nok\n${ESC}[?2004h$ `), "on");
});
