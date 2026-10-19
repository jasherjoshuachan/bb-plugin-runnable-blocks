import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  bashRcfile,
  integratedArgv,
  shellKind,
  shellQuote,
  ZSH_HOOKS,
  ZSH_LAUNCHER,
  zshWrapperFiles,
} from "../lib/integration.ts";
import { detectUserShell, prepareIntegration, writeIntegrationFiles } from "../lib/integration-files.ts";

test("shellKind: zsh and bash only", () => {
  assert.equal(shellKind("/bin/zsh"), "zsh");
  assert.equal(shellKind("/opt/homebrew/bin/zsh"), "zsh");
  assert.equal(shellKind("-zsh"), "zsh");
  assert.equal(shellKind("/usr/local/bin/zsh-5.9"), "zsh");
  assert.equal(shellKind("/bin/bash"), "bash");
  assert.equal(shellKind("/usr/bin/fish"), null);
  assert.equal(shellKind("/bin/sh"), null);
  assert.equal(shellKind("/bin/dash"), null);
  assert.equal(shellKind("/usr/bin/nu"), null);
});

test("shellQuote round-trips through sh", () => {
  for (const value of ["plain", "with space", "it's", `a"b$c\`d\\e`, ""]) {
    assert.equal(execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" }), value);
  }
});

test("zsh wrapper: every user file is guarded and quoted", () => {
  const files = zshWrapperFiles();
  for (const [name, content] of Object.entries(files)) {
    assert.match(content, new RegExp(`\\[\\[ -r "\\$__bb_rb_user_zd/\\${name}" \\]\\] && builtin source "\\$__bb_rb_user_zd/\\${name}"`));
    // No unquoted path expansions next to a file name.
    assert.doesNotMatch(content, /source \$/);
  }
  assert.match(files[".zshenv"], /unset BB_RB_USER_ZDOTDIR BB_RB_USER_ZDOTDIR_SET/);
  // .zshrc hands ZDOTDIR back before the hooks.
  const rc = files[".zshrc"];
  assert.ok(rc.indexOf("export ZDOTDIR=$__bb_rb_user_zd") < rc.indexOf("add-zsh-hook"));
});

test("zsh hooks: guarded, precmd first, preexec C, precmd D;$? and A, B inside %{ %}", () => {
  assert.match(ZSH_HOOKS, /^if \[\[ -z \$\{__bb_rb_hooked-\} \]\]; then/);
  assert.match(ZSH_HOOKS, /precmd_functions=\(__bb_rb_precmd \$\{precmd_functions\[@\]:#__bb_rb_precmd\}\)/);
  assert.match(ZSH_HOOKS, /add-zsh-hook preexec __bb_rb_preexec/);
  assert.match(ZSH_HOOKS, /133;C/);
  assert.match(ZSH_HOOKS, /133;D;%s/);
  assert.match(ZSH_HOOKS, /PS1\+=\$'%\{\\e\]133;B\\a%\}'/);
});

test("bash rcfile: guarded sourcing, PROMPT_COMMAND kept, PS0 or DEBUG", () => {
  const rc = bashRcfile();
  assert.match(rc, /\[ -r "\$HOME\/\.bashrc" \] && \. "\$HOME\/\.bashrc"/);
  assert.match(rc, /if \[ -r "\$HOME\/\.bash_profile" \]; then \. "\$HOME\/\.bash_profile"/);
  assert.match(rc, /if \[ -z "\$\{__bb_rb_loaded-\}" \]/);
  assert.match(rc, /if \[ -z "\$\{__bb_rb_hooked-\}" \]/);
  assert.match(rc, /PROMPT_COMMAND="__bb_rb_prompt_start"\$'\\n'"\$PROMPT_COMMAND"/);
  assert.match(rc, /PS0="\$\{PS0-\}"\$'\\e\]133;C\\a'/);
  assert.match(rc, /trap '__bb_rb_debug' DEBUG/);
});

test("bash and zsh files parse", () => {
  const dir = mkdtempSync(join(tmpdir(), "rb-parse-"));
  const bashFile = join(dir, "rc.bash");
  writeFileSync(bashFile, bashRcfile());
  execFileSync("/bin/bash", ["-n", bashFile]);
  for (const [name, content] of Object.entries(zshWrapperFiles())) {
    const file = join(dir, `${name.slice(1)}.zsh`);
    writeFileSync(file, content);
    execFileSync("/bin/zsh", ["-n", file]);
  }
});

test("hooks don't duplicate when sourced twice (zsh and bash)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rb-twice-"));
  const zshFile = join(dir, "hooks.zsh");
  writeFileSync(zshFile, ZSH_HOOKS);
  const zsh = execFileSync(
    "/bin/zsh",
    ["-f", "-c", `source ${shellQuote(zshFile)}; unset __bb_rb_hooked; source ${shellQuote(zshFile)}; print -r -- "$precmd_functions|$preexec_functions"`],
    { encoding: "utf8" },
  ).trim();
  assert.equal(zsh, "__bb_rb_precmd __bb_rb_prompt_end|__bb_rb_preexec");

  const bashFile = join(dir, "rc.bash");
  writeFileSync(bashFile, bashRcfile());
  const home = mkdtempSync(join(tmpdir(), "rb-home-"));
  const bash = execFileSync(
    "/bin/bash",
    ["--norc", "-c", `PROMPT_COMMAND='echo user'; . ${shellQuote(bashFile)}; . ${shellQuote(bashFile)}; printf %s "$PROMPT_COMMAND"`],
    { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin" } },
  );
  assert.equal(bash, "__bb_rb_prompt_start\necho user\n__bb_rb_prompt_end");
});

test("argv per shell; paths with spaces stay single arguments", () => {
  const paths = { zshDir: "/data dir/it's/zsh", bashRcfile: "/data dir/bash/runnable-blocks.bashrc" };
  assert.deepEqual(integratedArgv("zsh", "/bin/zsh", paths), [
    "/bin/sh",
    "-c",
    ZSH_LAUNCHER,
    "runnable-blocks",
    "/data dir/it's/zsh",
    "/bin/zsh",
  ]);
  assert.deepEqual(integratedArgv("bash", "/opt/homebrew/bin/bash", paths), [
    "/opt/homebrew/bin/bash",
    "--rcfile",
    "/data dir/bash/runnable-blocks.bashrc",
    "-i",
  ]);
  // The launcher reads paths from $1/$2 only, never spliced in.
  assert.doesNotMatch(ZSH_LAUNCHER, /data dir/);
});

test("zsh launcher hands over the user's ZDOTDIR (set, empty, unset)", () => {
  const probe = "/bin/sh";
  const script = ZSH_LAUNCHER.replace('exec "$2" -i', 'exec "$2" -c \'printf "%s|%s|%s" "$ZDOTDIR" "$BB_RB_USER_ZDOTDIR" "$BB_RB_USER_ZDOTDIR_SET"\'');
  const run = (env: Record<string, string>) =>
    execFileSync(probe, ["-c", script, "rb", "/wrap dir", "/bin/sh"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", ...env } });
  assert.equal(run({ ZDOTDIR: "/my zdot" }), "/wrap dir|/my zdot|1");
  assert.equal(run({ ZDOTDIR: "" }), "/wrap dir||1");
  assert.equal(run({}), "/wrap dir||");
});

test("detectUserShell: $SHELL, then the login shell, else null", async () => {
  const yes = async () => true;
  assert.equal(await detectUserShell({ env: { SHELL: "/bin/zsh" }, isExecutable: yes, loginShell: async () => null }), "/bin/zsh");
  assert.equal(
    await detectUserShell({ env: {}, isExecutable: yes, loginShell: async () => "/opt/homebrew/bin/bash" }),
    "/opt/homebrew/bin/bash",
  );
  assert.equal(await detectUserShell({ env: { SHELL: "zsh" }, isExecutable: yes, loginShell: async () => null }), null);
  assert.equal(
    await detectUserShell({ env: { SHELL: "/gone/zsh" }, isExecutable: async () => false, loginShell: async () => null }),
    null,
  );
});

test("writeIntegrationFiles is idempotent and prepareIntegration reports fish as unsupported", async () => {
  const root = join(mkdtempSync(join(tmpdir(), "rb-files-")), "with space", "shell-integration");
  const first = await writeIntegrationFiles(root);
  const before = statSync(first.bashRcfile).mtimeMs;
  const again = await writeIntegrationFiles(root);
  assert.deepEqual(again, first);
  assert.equal(statSync(again.bashRcfile).mtimeMs, before);
  assert.equal(readFileSync(join(first.zshDir, ".zshrc"), "utf8"), zshWrapperFiles()[".zshrc"]);

  const zsh = await prepareIntegration(root, { env: { SHELL: "/bin/zsh" } });
  assert.equal(zsh.available, true);
  const fish = await prepareIntegration(root, { env: { SHELL: "/usr/bin/fish" }, isExecutable: async () => true });
  assert.equal(fish.available, false);
  assert.equal(fish.shell, "/usr/bin/fish");
});
