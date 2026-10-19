# bb-plugin-runnable-blocks

Run shell code blocks from agent replies in [bb](https://getbb.app) with one click.

Agents hand you commands in code blocks all day. Copying each one into a terminal is slow, and pasting a multi-line block into a shell can run half of it before you notice a typo. This plugin adds a small toolbar under every `bash`, `sh`, `zsh`, `shell` and `console` block in an agent reply:

- **Run** sends the command to the thread's "Run blocks" terminal and presses Enter.
- **Insert into terminal** types it in without pressing Enter, so you can edit it first.
- **Insert into composer** adds it to your message draft.
- **Run in new terminal** runs it in a fresh terminal tab.

The terminal opens in the side panel, in the thread's folder and on the thread's machine. A **Ran** badge marks blocks you've already run.

## Install

```sh
bb plugin install git:https://github.com/jasherjoshuachan/bb-plugin-runnable-blocks.git@v0.1.0
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

## Settings

| Where | Setting | Default | Meaning |
|---|---|---|---|
| `bb plugin config runnable-blocks set confirmEveryRun true` | `confirmEveryRun` | `false` | Ask before every run, in every thread |
| Confirmation dialog | Don't ask again in this thread | on | Skip the dialog for later single-line runs in this thread |
| Confirmation dialog | Always ask before running | off | Same as `confirmEveryRun`, for this browser only |

Multi-line and risky commands always ask, whatever these say. The per-thread memory and the Ran badges are kept in this browser's local storage (capped at 200 threads and 500 blocks).

## How it works

- `app.tsx` registers an `experimental_codeFenceRenderer` for the five shell languages. It renders bb's own code block (`Original`) unchanged, with copy and highlighting, and adds the toolbar.
- `lib/parse.ts` turns the block into a command. It trims blank lines. In `console` blocks it keeps only the `$ ` lines (or `# ` lines in a root session with no `$ `) with the prompt removed, plus their `\` and `> ` continuation lines. If a `console` block has no prompt lines, it gets no Run. If every line of a `bash` block starts with `$ `, the prompt is stripped there too.
- `lib/terminal.ts` lists the thread's terminals and reuses the newest running one titled "Run blocks" whose shell is idle. Otherwise it creates one with `terminals.create({ scope: { kind: "thread", threadId }, title: "Run blocks", start: { mode: "shell" } })` and waits up to 4 seconds for the prompt. To tell whether the shell is idle, it reads the last 4 KB of output: zsh, bash 5.1+ and fish turn bracketed paste on at the prompt and off while a command runs.
- `lib/paste.ts` builds `ESC[200~ command ESC[201~` (plus `\r` for Run), encodes it as UTF-8 base64, and sends it with `terminals.input`. The terminal is then shown with `useBbNavigate().experimental_openTerminal`. If that call is missing or returns false, a toast says where the command went.
- `server.ts` only declares the `confirmEveryRun` setting. The plugin makes no network calls and runs no commands of its own. It has no telemetry. Its one runtime dependency is `@radix-ui/react-slot`.
- On a bb without the code-fence slot, the plugin does nothing and bb shows its normal code blocks. If the terminals API is missing, only Insert into composer is offered.

## Limitations

- A reused shell gives no exit code per command.
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

To try it, ask an agent in a thread to reply with a fenced `bash` block (for example `echo hello from runnable-blocks`). Then use the toolbar under the block.

## License

MIT
