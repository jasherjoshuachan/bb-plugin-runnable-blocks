// Runs real interactive zsh and bash with the generated integration files in
// a pseudo-terminal (via `script`, no native modules) inside a temp HOME, and
// checks the OSC 133 marks and that the user's own startup files still work.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { integratedArgv, type ShellKind, shellQuote } from "../lib/integration.ts";
import { writeIntegrationFiles } from "../lib/integration-files.ts";
import { Osc133Parser } from "../lib/osc133.ts";

const SCRIPT = "/usr/bin/script";
const canPty = (process.platform === "darwin" || process.platform === "linux") && existsSync(SCRIPT);
const PROMPT_MARK = "\u001b]133;A";

/**
 * Runs argv in a pty and types each line once the shell shows a new prompt
 * (an OSC 133;A mark). Node's pipes are sockets, which `script` refuses, so
 * `cat` pipes sit on both sides.
 */
function runInPty(argv: string[], env: Record<string, string>, lines: string[], timeoutMs = 20_000): Promise<string> {
  const inner =
    process.platform === "darwin"
      ? `cat | ${SCRIPT} -q /dev/null "$@" | cat`
      : `cat | ${SCRIPT} -q -e -c ${shellQuote(argv.map(shellQuote).join(" "))} /dev/null | cat`;
  const child = spawn("/bin/sh", ["-c", inner, "sh", ...(process.platform === "darwin" ? argv : [])], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let sent = 0;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out; output so far: ${JSON.stringify(out)}`));
    }, timeoutMs);
    const onData = (data: Buffer) => {
      out += data.toString("utf8");
      const prompts = out.split(PROMPT_MARK).length - 1;
      while (sent < lines.length && prompts > sent) {
        child.stdin.write(`${lines[sent]}\r`);
        sent++;
        if (sent === lines.length) child.stdin.end();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

function exitCodes(output: string): Array<number | null> {
  const parser = new Osc133Parser();
  parser.feed(output);
  return parser.runs.map((run) => run.exitCode);
}

function baseEnv(home: string): Record<string, string> {
  return { HOME: home, PATH: "/usr/bin:/bin", TERM: "xterm-256color", USER: process.env.USER ?? "user", LANG: "C" };
}

async function setup(): Promise<{ root: string; home: string; paths: Awaited<ReturnType<typeof writeIntegrationFiles>> }> {
  const root = mkdtempSync(join(tmpdir(), "rb pty "));
  const home = join(root, "home with space");
  mkdirSync(home);
  const paths = await writeIntegrationFiles(join(root, "data dir", "shell-integration"));
  return { root, home, paths };
}

const zshPath = "/bin/zsh";
const bashPaths = ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/bin/bash", "/usr/bin/bash"].filter(existsSync);

test("zsh: D;0 and D;1, user's hook, variable and ZDOTDIR survive", { skip: !canPty || !existsSync(zshPath) }, async () => {
  const { home, paths } = await setup();
  writeFileSync(join(home, ".zshenv"), "export FROM_ZSHENV=env-ok\n");
  writeFileSync(
    join(home, ".zshrc"),
    [
      "export MYVAR=hello",
      'my_hook() { print -n "MYHOOK:$?|" }',
      "precmd_functions+=(my_hook)",
      "PS1='%# '",
      "",
    ].join("\n"),
  );
  const out = await runInPty(integratedArgv("zsh", zshPath, paths), baseEnv(home), [
    "true",
    "false",
    'echo "v=$MYVAR e=$FROM_ZSHENV zd=${ZDOTDIR-unset}"',
    "sh -c 'exit 127'",
    "sh -c 'exit 130'",
    "exit",
  ]);
  assert.ok(out.includes("\u001b]133;D;0\u0007"), "D;0");
  assert.ok(out.includes("\u001b]133;D;1\u0007"), "D;1");
  assert.deepEqual(exitCodes(out), [0, 1, 0, 127, 130]);
  assert.ok(out.includes("MYHOOK:1|"), "user's precmd hook ran and saw $?");
  assert.ok(out.includes("v=hello e=env-ok zd=unset"), "user's variables set; ZDOTDIR restored to unset");
  assert.ok(out.includes("\u001b]133;B\u0007"), "prompt-end mark in PS1");
});

test("zsh: a user ZDOTDIR (with spaces) is honored and handed back", { skip: !canPty || !existsSync(zshPath) }, async () => {
  const { root, home, paths } = await setup();
  const zdot = join(root, "my zdot dir");
  mkdirSync(zdot);
  writeFileSync(join(zdot, ".zshrc"), "export FROM_ZDOT=yes\nPS1='> '\n");
  writeFileSync(join(home, ".zshrc"), "export FROM_HOME=wrong\n");
  const out = await runInPty(integratedArgv("zsh", zshPath, paths), { ...baseEnv(home), ZDOTDIR: zdot }, [
    'echo "z=$FROM_ZDOT h=${FROM_HOME-none} d=$ZDOTDIR"',
    "exit",
  ]);
  assert.ok(out.includes(`z=yes h=none d=${zdot}`), out);
  assert.deepEqual(exitCodes(out), [0]);
});

test("zsh: a broken ~/.zshrc doesn't break the shell or the marks", { skip: !canPty || !existsSync(zshPath) }, async () => {
  const { home, paths } = await setup();
  writeFileSync(join(home, ".zshrc"), "export BEFORE=1\nif [[ ; then\n");
  const out = await runInPty(integratedArgv("zsh", zshPath, paths), baseEnv(home), ["false", "exit"]);
  assert.deepEqual(exitCodes(out), [1]);
});

for (const bash of bashPaths.slice(0, 2)) {
  test(`bash (${bash}): D;0 and D;1, user's PROMPT_COMMAND and variable survive`, { skip: !canPty }, async () => {
    const { home, paths } = await setup();
    writeFileSync(join(home, ".bashrc"), ["export MYVAR=hello", "PROMPT_COMMAND='printf \"MYHOOK:$?|\"'", "PS1='$ '", ""].join("\n"));
    const out = await runInPty(integratedArgv("bash" as ShellKind, bash, paths), baseEnv(home), [
      "true",
      "false",
      'echo "v=$MYVAR"',
      "sh -c 'exit 127'",
      "exit",
    ]);
    assert.ok(out.includes("\u001b]133;D;0\u0007"), "D;0");
    assert.ok(out.includes("\u001b]133;D;1\u0007"), "D;1");
    assert.deepEqual(exitCodes(out), [0, 1, 0, 127]);
    assert.ok(out.includes("MYHOOK:1|"), "user's PROMPT_COMMAND ran and saw $?");
    assert.ok(out.includes("v=hello"));
  });
}
