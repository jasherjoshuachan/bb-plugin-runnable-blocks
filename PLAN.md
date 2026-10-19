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

## v0.2
- An output preview (last 20 lines) and an exit-code chip for new-terminal runs.
- Opt-in exit status in the reused shell. PowerShell support. A settings section (languages, confirm mode, reuse vs new, extra risky patterns).

## Risks
- `experimental_codeFenceRenderer` and `experimental_openTerminal` are experimental. Guard them with `typeof` checks.
- If another plugin claims `bash`, bb falls back to its own block and the buttons disappear.
- A reused shell gives no per-command exit code.
