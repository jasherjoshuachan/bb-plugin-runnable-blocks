# bb-plugin-runnable-blocks: plan

A ▶ Run button on shell code blocks in agent replies. It runs the command in the thread's side-panel terminal, like Claude Code Desktop's code block Run.

## Prior art
- Claude Code Desktop: a code block's Run goes to the integrated terminal and uses the selected terminal tab when it's idle (https://claude.com/docs/cowork/changelog). The terminal opens in the session's working directory with the same environment as Claude (https://code.claude.com/docs/en/desktop). Confirmation and danger warnings aren't documented.
- VS Code Copilot Chat: "Insert into Terminal" puts the command in without pressing Enter, and never runs it automatically.
- No bb plugin does this yet (bb catalog checked October 2026).

## SDK surface
- `app.slots.experimental_codeFenceRenderer({ id, languages, component })`. The component gets `{ code, language, status, index, message, Original }`. It is active only in assistant and nested-agent messages, so user messages never get buttons.
- `useSdk().terminals.create({ cols, rows, scope: { kind: "thread", threadId }, title, start })`, plus `terminals.list`, `terminals.input({ terminalId, dataBase64 })` and `terminals.output(...)`.
- `useBbNavigate().experimental_openTerminal({ terminalId })` reveals the terminal in the side panel.
- `useComposer().insert(text, { at: "end", block: true })`.

## v0.1
- Fence renderer for `bash sh zsh shell console`, rendering `<Original/>` plus a toolbar: **Run**, **Insert into terminal** (no Enter), **Insert into composer**, **Run in new terminal**.
- Buttons appear only when `status === "closed"`. An `unclosed` block gets Insert only.
- Sends the command as bracketed paste (`ESC[200~ … ESC[201~`) so heredocs and multi-line blocks arrive as one unit. Run adds `\r`.
- `console` blocks: keep only the `$ ` / `# ` lines with the prompt removed. If no line has a prompt, the block gets no Run.
- Reuses one "Run blocks" terminal per thread when it is running. Otherwise it creates one. It then opens the terminal in the side panel.
- Confirmation: the first Run in a thread shows the command, folder and machine. Multi-line blocks always confirm. Risky patterns (`rm -rf`, `sudo`, `curl|sh`, `mkfs`, `dd of=`, `chmod -R 777`, `git push --force`, `git reset --hard`, fork bomb, writes to `/dev/sd*`) need an explicit "Run anyway". A setting can confirm every run.
- A "Ran" badge per block, keyed `${message.id}#${language}#${index}`.

## v0.2 (done)
- Exit status through shell integration, with nothing added to the user's commands. "Run blocks" terminals start zsh or bash with a startup wrapper written by the server into the plugin's data folder (`dirname(bb.storage.database().name)/shell-integration`). It loads the user's own files first, then adds OSC 133 hooks: C before output, `D;$?` after, A/B around the prompt. Same scheme as VS Code, iTerm2 and Warp.
  - zsh: a ZDOTDIR wrapper (`.zshenv`, `.zprofile`, `.zshrc`, `.zlogin`), started as `/bin/sh -c <launcher> runnable-blocks <wrapper dir> <zsh>`. The launcher passes the user's ZDOTDIR, set or unset, read from the terminal's real environment at start time. `.zshrc` hands ZDOTDIR back before the hooks.
  - bash: `bash --rcfile <file> -i`, which loads `~/.bashrc`, then `PROMPT_COMMAND` (ours first and last, the user's in between), plus `PS0` (4.4+) or a `DEBUG` trap.
  - Only when the thread's host is the bb server's own host (`primaryHostId`) and the shell (`$SHELL`, else the login shell) is zsh or bash. Otherwise v0.1 behavior.
  - With integration on, v0.1 terminals (no OSC 133 marks in their tail) aren't reused. "Run in new terminal" also gets integration, through `start: { mode: "argv" }`, never `mode: "command"`.
- `lib/osc133.ts`: a streaming parser that handles split sequences, BEL/ST, C1, unknown or cut-short OSC, CR/LF, color stripping, and a 20-line / 4 KB preview. A paste-mode fallback (`?2004l` … `?2004h`) gives a preview without an exit code for shells without integration.
- `lib/watch.ts`: reads `nextSeq` before sending, then polls `terminals.output({ sinceSeq })`. It stops on D, terminal exit, 30 minutes or unmount, and resumes from the stored seq on remount.
- UI: a status chip (Running… / ✓ 0 / ✗ code), a collapsible preview and Open terminal. Persisted per block key (100 runs, 4 KB each).
- Settings (`bb.settings.define`, validated with `experimental_schema`): languages, confirm mode, reuse vs new terminal, extra risky patterns, show output preview, shell integration.
- Tests: the parser (every split point), rc-file generation and parse checks, re-source idempotence, argv and quoting, settings, the watcher, run storage, and real `zsh -i` / `bash -i` (5.x and 3.2) runs in a pty via `script`.

## Later
- PowerShell support (OSC 633 / 133 from a profile wrapper).
- fish integration (`fish_preexec` / `fish_postexec` events) through `--init-command`.
- Remote hosts: write the files on the target host (needs a host-side write API).

## Risks
- `experimental_codeFenceRenderer` and `experimental_openTerminal` are experimental. Guard them with `typeof` checks.
- If another plugin claims `bash`, bb falls back to its own block and the buttons disappear.
- A reused shell without integration gives no per-command exit code (v0.2 fixes this for zsh/bash on the server's machine).
