Run shell code blocks from agent replies in the thread's terminal.

## What you get

- A toolbar under every `bash`, `sh`, `zsh`, `shell` and `console` block in an agent reply: Run, Insert into terminal, Insert into composer, Run in new terminal.
- Commands run in a "Run blocks" terminal that opens in the side panel, in the thread's folder and on the thread's machine.
- A "Ran" badge on blocks you've run, plus a status chip (Running…, ✓ 0, ✗ 1) and a preview of the last 20 lines of output.
- Exit status through standard shell integration (OSC 133) for zsh and bash. Your commands are sent exactly as written.

## Safety

Nothing runs without a click. You confirm the first run in each thread, and multi-line blocks always ask. Risky commands like `rm -rf`, `sudo`, `curl … | sh` and force pushes need an explicit "Run anyway". Commands are pasted with control characters stripped, so a block can't smuggle in extra keystrokes. The plugin makes no network calls and needs no account or API key.
