import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBlock, SHELL_LANGUAGES, stripConsolePrompts, trimBlock } from "../lib/parse.ts";

test("claims the planned languages", () => {
  assert.deepEqual([...SHELL_LANGUAGES], ["bash", "sh", "zsh", "shell", "console"]);
});

test("bash block: trailing newlines trimmed, single line", () => {
  const parsed = parseBlock("npm test\n\n", "bash");
  assert.deepEqual(parsed, { command: "npm test", runnable: true, multiLine: false });
});

test("leading blank lines and trailing spaces are trimmed, inner lines kept", () => {
  assert.equal(trimBlock("\n\n  a\n\n  b  \n \n"), "  a\n\n  b");
});

test("CRLF becomes LF", () => {
  assert.equal(parseBlock("echo a\r\necho b\r\n", "sh").command, "echo a\necho b");
});

test("multi-line detection", () => {
  assert.equal(parseBlock("cd app\nnpm install", "zsh").multiLine, true);
  assert.equal(parseBlock("cat <<'EOF'\nhi\nEOF\n", "bash").multiLine, true);
  assert.equal(parseBlock("ls -la\n", "shell").multiLine, false);
});

test("empty or blank block is not runnable", () => {
  assert.equal(parseBlock("", "bash").runnable, false);
  assert.equal(parseBlock("\n  \n", "bash").runnable, false);
});

test("language is matched case-insensitively", () => {
  assert.equal(parseBlock("$ ls\nout", "CONSOLE").command, "ls");
});

test("bash block where every line has a $ prompt is stripped", () => {
  assert.equal(parseBlock("$ npm ci\n$ npm test\n", "bash").command, "npm ci\nnpm test");
});

test("bash block with mixed $ lines is left alone", () => {
  assert.equal(parseBlock("echo $HOME\n$ ls", "bash").command, "echo $HOME\n$ ls");
  assert.equal(parseBlock("echo $HOME", "bash").command, "echo $HOME");
});

test("console: keeps $ lines, drops output", () => {
  const code = "$ npm test\nok 1\nall good\n$ echo done\ndone\n";
  assert.equal(stripConsolePrompts(code), "npm test\necho done");
});

test("console: output only gets no command", () => {
  const parsed = parseBlock("total 0\ndrwxr-xr-x  2 user staff 64 .\n", "console");
  assert.equal(parsed.runnable, false);
  assert.equal(parsed.command, "");
});

test("console: # lines are comments when $ prompts exist", () => {
  assert.equal(parseBlock("# install deps\n$ npm ci\n", "console").command, "npm ci");
});

test("console: # is the prompt in a root session", () => {
  assert.equal(
    parseBlock("# apt-get update\nHit:1 http://archive\n# whoami\nroot\n", "console").command,
    "apt-get update\nwhoami",
  );
});

test("console: backslash continuation lines are kept", () => {
  const code = "$ docker run \\\n  --rm \\\n  alpine echo hi\nhi\n";
  const parsed = parseBlock(code, "console");
  assert.equal(parsed.command, "docker run \\\n  --rm \\\n  alpine echo hi");
  assert.equal(parsed.multiLine, true);
});

test("console: > continuation prompts in a heredoc", () => {
  const code = "$ cat <<EOF\n> one\n> two\n> EOF\none\ntwo\n";
  assert.equal(parseBlock(code, "console").command, "cat <<EOF\none\ntwo\nEOF");
});

test("console: > lines after output are output, not continuations", () => {
  assert.equal(parseBlock("$ npm test\nresult\n> quoted output\n", "console").command, "npm test");
});

test("console: bare $ line counts as an empty prompt", () => {
  assert.equal(parseBlock("$ ls\nfile\n$\n", "console").command, "ls");
});
