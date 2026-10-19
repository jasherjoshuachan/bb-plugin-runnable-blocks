# bb-plugin-runnable-blocks

Run shell code blocks from agent replies in [bb](https://getbb.app) with one click.

Agents hand you commands in code blocks all day. Copying each one into a terminal is slow, and pasting a multi-line block into a shell can run half of it before you notice a typo. This plugin adds a small toolbar under every `bash`, `sh`, `zsh`, `shell` and `console` block in an agent reply:

- **Run** sends the command to the thread's "Run blocks" terminal and presses Enter.
- **Insert into terminal** types it in without pressing Enter, so you can edit it first.
- **Insert into composer** adds it to your message draft.
- **Run in new terminal** runs it in a fresh terminal tab.

The terminal opens in the side panel, in the thread's folder and on the thread's machine. A **Ran** badge marks blocks you've already run.

After a Run, the block shows how it went:

- a status chip: **Running… 12s** while it runs, then **✓ 0** or **✗ 1** (the exit code; hover it for "interrupted" on 130 or "command not found" on 127),
- a collapsible **Output** preview with the last 20 lines (opened on its own when the command fails),
- an **Open terminal** link to the terminal it ran in.

The status survives a reload. If you scroll away while a command is still running, it picks up again when the block comes back (for up to 30 minutes).

## Install

```sh
bb plugin install git:https://github.com/jasherjoshuachan/bb-plugin-runnable-blocks.git@v0.2.0
```

Requires bb 0.46 or later.

## Safety model

- **Nothing runs on its own.** Every run starts with a click. Buttons appear only after the block has finished streaming; an interrupted block (no closing fence) gets the Insert buttons only.
- **You confirm before the first run in each thread.** The dialog shows the command, the folder, and the machine name when it isn't this computer.
- **Multi-line blocks always ask.**
- **Risky commands need "Run anyway".** The check flags `rm -rf`, `sudo`/`doas`, downloads piped into a shell (`curl … | sh`, `bash -c "$(curl …)"`), `mkfs`, `dd of=`, `chmod -R 777`, force pushes (`--force`, `-f`, `--force-with-lease`, `+ref`), `git reset --hard`, fork bombs, and writes to raw disk devices (`> /dev/sda`). It reads the command as text and doesn't parse quoting, so `echo "rm -rf"` is flagged too. It's a speed bump, not a sandbox: an obfuscated command can slip past it.
- **Paste injection is blocked.** Commands go in as a bracketed paste, so a multi-line block or heredoc arrives as one unit. Before wrapping, the plugin strips every escape and control character except tab and newline. A block that contains its own paste-end sequence (`ESC[201~`) can't break out of the paste and run the rest as typed keys.
- **It won't type into a busy shell.** If the "Run blocks" terminal is running something (a dev server, say), Run opens a new "Run blocks" terminal instead.
- Only assistant and sub-agent replies get buttons. Your own messages never do.

## How exit status works

A terminal only shows text, so on its own it can't tell the plugin when a command ended or whether it worked. Most modern terminals (VS Code, iTerm2, Warp, WezTerm) solve this with **shell integration**: the shell prints a few invisible markers around each command, a standard called OSC 133. One marker says "the command's output starts here", another says "the command finished, with exit code N".

Runnable Blocks does the same for its own "Run blocks" terminals:

- When it opens one, it starts your shell (zsh or bash) with a small startup file from the plugin's data folder. That file first loads your own startup files exactly as usual (`.zshenv`, `.zshrc`, `ZDOTDIR` and so on for zsh; `.bashrc` for bash), then adds two prompt hooks that print the markers. Your own hooks, prompt and variables stay as they are.
- Your commands are sent exactly as written. Nothing is added to them: no `; echo $?`, no wrapper.
- The plugin reads the terminal's output after your command, takes what comes between the "output starts" and "finished" markers, strips colors and other escape codes, and keeps the last 20 lines (at most 4 KB).

Terminals you open yourself, and other plugins' terminals, are never changed.

When integration isn't available, Run still works the v0.1 way. The preview still shows output (taken from where the shell accepted the line to the next prompt), but the chip says **Finished** without an exit code. That happens when:

- your shell is fish, nushell, PowerShell or anything other than zsh and bash,
- the thread runs on another machine (a remote host): the startup files live on the bb server's machine, so they are only used for threads on that machine,
- you turn **Shell integration** off in the settings,
- the terminal is an older "Run blocks" terminal from v0.1. With integration on, the plugin skips those and opens a new integrated one.

The generated files live in `<bb data folder>/plugins/runnable-blocks/shell-integration/` and are rewritten when they change. They are safe to read and safe to delete.

## Settings

In bb: Settings → Installed plugins → Runnable Blocks, or `bb plugin config runnable-blocks set <key> <value>`.

| Setting | Key | Default | Meaning |
|---|---|---|---|
| Languages | `languages` | `bash,sh,zsh,shell,console` | Which code block languages get the toolbar (any of those five) |
| Confirm before running | `confirmMode` | `first-run` | `first-run`: ask once per thread. `every-run`: ask every time |
| Run uses | `terminalMode` | `reuse` | `reuse` the thread's idle "Run blocks" terminal, or open a `new` one for every Run |
| Extra risky patterns | `extraRiskyPatterns` | empty | Your own regular expressions, comma-separated (write a literal comma as `\,`). A match needs "Run anyway". Invalid patterns are refused when you save |
| Show output preview | `showOutputPreview` | on | The last-20-lines preview under each run |
| Shell integration | `shellIntegration` | on | Start "Run blocks" terminals with the OSC 133 hooks (exit status) |

The confirmation dialog also has **Don't ask again in this thread** (on by default) and **Always ask before running** (this browser only).

Multi-line and risky commands always ask, whatever these say. The per-thread memory, the Ran badges and the run status are kept in this browser's local storage (capped at 200 threads, 500 badges and 100 runs with 4 KB of output each).

`confirmEveryRun` from v0.1 is replaced by `confirmMode`. If you had set it, set `confirmMode` to `every-run`.

## How it works

- `app.tsx` registers an `experimental_codeFenceRenderer` for the five shell languages. It renders bb's own code block (`Original`) unchanged, with copy and highlighting, and adds the toolbar.
- `lib/parse.ts` turns the block into a command. It trims blank lines. In `console` blocks it keeps only the `$ ` lines (or `# ` lines in a root session with no `$ `) with the prompt removed, plus their `\` and `> ` continuation lines. If a `console` block has no prompt lines, it gets no Run. If every line of a `bash` block starts with `$ `, the prompt is stripped there too.
- `lib/terminal.ts` lists the thread's terminals and reuses the newest running one titled "Run blocks" whose shell is idle (with integration on, only one whose output carries OSC 133 marks). Otherwise it creates one with `terminals.create({ scope: { kind: "thread", threadId }, title: "Run blocks", start })` and waits up to 4 seconds for the prompt. `start` is `{ mode: "argv", argv }` for an integrated shell and `{ mode: "shell" }` otherwise; it is never a command string. To tell whether the shell is idle, it reads the last 4 KB of output: zsh, bash 5.1+ and fish turn bracketed paste on at the prompt and off while a command runs.
- `lib/integration.ts` builds the startup files and the argv. For zsh, the argv is `/bin/sh -c <launcher> runnable-blocks <wrapper dir> <zsh>`: the launcher records your `ZDOTDIR` (set or not) and starts `zsh -i` with `ZDOTDIR` pointing at the wrapper, whose `.zshenv`, `.zprofile` and `.zshrc` each load yours and whose `.zshrc` hands `ZDOTDIR` back before adding the hooks with `add-zsh-hook` (`preexec` prints C; `precmd`, placed first, prints `D;$?` and A; the B mark is appended to `PS1` inside `%{ %}` so the prompt width doesn't change). For bash it is `bash --rcfile <file> -i`; the file loads `~/.bashrc` and adds `PROMPT_COMMAND` hooks (yours kept in between) plus `PS0`, or a `DEBUG` trap on bash older than 4.4 when you have none. Every user file is loaded only if readable, and the hooks install once even if sourced again.
- `server.ts` declares the settings and one RPC method, `shellIntegration`. It finds your shell (`$SHELL`, else the account's login shell via `dscl` on macOS or the passwd entry), writes the files into the plugin's data folder, and returns the argv. The frontend uses it only when the thread's machine is the bb server's own machine (`system.config().primaryHostId`).
- `lib/osc133.ts` is a streaming parser for terminal output. It handles escape sequences split across chunks, BEL and ST terminators, 8-bit C1 forms, unknown and cut-short OSC sequences, CR/LF, progress-bar carriage returns and backspaces. `lib/watch.ts` reads the terminal's position (`nextSeq`) before sending the command, then polls `terminals.output({ sinceSeq })` (quickly at first, then every 1 to 3 seconds) until the run's D mark, the terminal exits, 30 minutes pass, or the block unmounts.
- `lib/paste.ts` builds `ESC[200~ command ESC[201~` (plus `\r` for Run), encodes it as UTF-8 base64, and sends it with `terminals.input`. The terminal is then shown with `useBbNavigate().experimental_openTerminal`. If that call is missing or returns false, a toast says where the command went.
- The plugin makes no network calls. The only process it starts itself is `dscl` (macOS) to read your login shell. It has no telemetry. Its one runtime dependency is `@radix-ui/react-slot`.
- On a bb without the code-fence slot, the plugin does nothing and bb shows its normal code blocks. If the terminals API is missing, only Insert into composer is offered.

## Limitations

- Exit status needs zsh or bash on the bb server's own machine. fish, other shells and remote hosts get the output preview without an exit code.
- The first Run in a thread can take a few seconds longer than opening a plain terminal. bb starts an argv terminal through a login shell (`$SHELL -lc`), so your login files (`.zprofile`, `.zlogin`, `.bash_profile`) run before the integrated shell starts. The block shows **Starting terminal…** and waits up to 30 seconds for the prompt before sending, so nothing is typed into your startup files. Later Runs reuse the terminal.
- A multi-line block runs as one command line, so it reports one exit code: the last command's.
- If your `.zshrc` replaces the shell (`exec tmux`, `exec fish`), the hooks never load and runs show **Finished** without a code.
- Prompt themes that rebuild `PS1` after every hook may drop the prompt-end (B) marker. The plugin doesn't need it; the exit code comes from the C and D markers.
- Output is read from the terminal's scrollback. If a command prints more than the scrollback holds before the plugin reads it, the preview says earlier output was skipped.
- If another plugin also claims `bash` (or another of these languages), bb falls back to its own block for that language and the toolbar disappears.
- Shells without bracketed paste (macOS's old `/bin/bash` 3.2, `sh`, Windows shells) may show the paste markers as text. Use zsh, bash 5.1+ or fish.

## Develop

```sh
npm install
npm run typecheck
npm test
npm run build      # bb plugin build -> dist/
bb plugin install path:$PWD
```

`npm test` includes real-shell tests: it starts `zsh -i` and `bash -i` with the generated files in a temporary home folder inside a pseudo-terminal (through `script`, no native modules) and checks the markers, exit codes and that the user's own hooks and variables still work.

To try it, ask an agent in a thread to reply with a fenced `bash` block (for example `echo hello from runnable-blocks`). Then use the toolbar under the block.

## License

MIT
