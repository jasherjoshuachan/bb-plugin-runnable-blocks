// Runnable Blocks — frontend.
//
// Claims bash/sh/zsh/shell/console fences in assistant replies. Each fence
// renders bb's own code block (<Original/>) unchanged, plus a small toolbar
// once the fence has closed:
//   Run · Insert into terminal · Insert into composer · Run in new terminal
// and, after a Run, a status chip (Running… / ✓ 0 / ✗ <code>) with a
// collapsible preview of the run's last output lines.
//
// Exit status comes from shell integration: on the bb server's own machine,
// "Run blocks" terminals start zsh or bash with prompt hooks that print the
// standard OSC 133 marks (see lib/integration.ts). Commands are sent exactly
// as written; nothing is appended to them.
//
// Nothing runs without a click. Run confirms the first time in a thread, for
// every multi-line block, and for risky commands (explicit "Run anyway").
// Commands go to the thread's "Run blocks" terminal as a sanitized bracketed
// paste, then the terminal is revealed in the side panel.
//
// Experimental APIs are feature-checked so an older or newer bb degrades to
// bb's plain code block or to Insert-only instead of throwing.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useComposer,
  useRpc,
  useSdk,
  useSettings,
  type ExperimentalCodeFenceRendererProps,
  type PluginBrowserBbSdk,
  type PluginSettingsState,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { formatHomePathForDisplay } from "@/lib/utils";
import { confirmReason, type ConfirmReason } from "./lib/confirm.ts";
import { runChip, type ChipTone } from "./lib/format.ts";
import type { IntegrationInfo } from "./lib/integration-files.ts";
import { parseBlock, SHELL_LANGUAGES } from "./lib/parse.ts";
import { findRisks, type Risk } from "./lib/risk.ts";
import { canResume, getRun, saveRun, type RunRecord } from "./lib/runs.ts";
import { readSettings } from "./lib/settings.ts";
import { currentSeq, startRecord, watchRun } from "./lib/watch.ts";
import type { rpcContract } from "./server.ts";
import {
  blockKey,
  browserStore,
  getAskEveryRun,
  hasRan,
  isKnownIntegrated,
  isThreadConfirmed,
  markRan,
  rememberIntegrated,
  setAskEveryRun,
  setThreadConfirmed,
} from "./lib/state.ts";
import {
  acquireTerminal,
  findReusableTerminal,
  isTerminalsApi,
  RUN_TERMINAL_TITLE,
  sendCommand,
  type TerminalsApi,
} from "./lib/terminal.ts";

type Action = "run" | "run-new" | "insert";

interface Target {
  cwd: string | null;
  /** Machine name, only when it isn't this bb's primary machine. */
  machine: string | null;
  reused: boolean;
}

interface PendingConfirm {
  action: Exclude<Action, "insert">;
  /** The run opens a new terminal. */
  fresh: boolean;
  reason: ConfirmReason;
  risks: Risk[];
  target: Target | null;
}

type OpenTerminal = (options: { terminalId: string }) => Promise<boolean>;

/** Calls a hook only when the host provides it (older hosts may not). */
function useOptional<T>(hook: unknown): T | null {
  return typeof hook === "function" ? (hook as () => T)() : null;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

type RpcClient = ReturnType<typeof useRpc<typeof rpcContract>>;

/** The server's integration answer, asked once per page; a failure is retried next time. */
let integrationInfo: Promise<IntegrationInfo | null> | null = null;
function loadIntegration(rpc: RpcClient | null): Promise<IntegrationInfo | null> {
  if (rpc === null) return Promise.resolve(null);
  integrationInfo ??= rpc.call("shellIntegration", null).catch(() => {
    integrationInfo = null;
    return null;
  });
  return integrationInfo;
}

/** The thread's machine, and whether it is the bb server's own machine. Never throws. */
async function threadHost(
  sdk: PluginBrowserBbSdk | null,
  threadId: string,
): Promise<{ cwd: string | null; hostId: string | null; primaryHostId: string | null }> {
  let cwd: string | null = null;
  let hostId: string | null = null;
  let primaryHostId: string | null = null;
  if (sdk === null) return { cwd, hostId, primaryHostId };
  try {
    const thread = await sdk.threads.get({ threadId });
    if (thread.environmentId !== null) {
      const environment = await sdk.environments.get({ environmentId: thread.environmentId });
      cwd = environment.path;
      hostId = environment.hostId;
    }
  } catch {
    // unknown folder
  }
  try {
    primaryHostId = (await sdk.system.config()).primaryHostId;
  } catch {
    // unknown
  }
  return { cwd, hostId, primaryHostId };
}

/**
 * The argv for an integrated terminal in this thread, or null for a plain
 * shell: integration is off, the shell isn't zsh/bash, or the thread runs on
 * another machine (the integration files live on the bb server's machine).
 */
async function integrationArgvFor(
  sdk: PluginBrowserBbSdk | null,
  rpc: RpcClient | null,
  threadId: string,
  enabled: boolean,
): Promise<string[] | null> {
  if (!enabled) return null;
  const [info, host] = await Promise.all([loadIntegration(rpc), threadHost(sdk, threadId)]);
  if (info === null || !info.available) return null;
  if (host.hostId === null || host.primaryHostId === null || host.hostId !== host.primaryHostId) return null;
  return info.argv;
}

/** Best-effort folder and machine for the confirmation dialog. Never throws. */
async function describeTarget(
  sdk: PluginBrowserBbSdk | null,
  api: TerminalsApi,
  threadId: string,
  fresh: boolean,
  requireIntegration: boolean,
): Promise<Target> {
  let cwd: string | null = null;
  let hostId: string | null = null;
  let reused = false;
  if (!fresh) {
    try {
      const found = await findReusableTerminal(api, threadId, {
        requireIntegration,
        knownIntegrated: (id) => isKnownIntegrated(browserStore(), id),
      });
      if (found !== null) {
        cwd = found.terminal.initialCwd;
        hostId = found.terminal.hostId;
        reused = true;
      }
    } catch {
      // fall through to the thread's environment
    }
  }
  const host = await threadHost(sdk, threadId);
  if (cwd === null) {
    cwd = host.cwd;
    hostId = host.hostId;
  }
  let machine: string | null = null;
  if (hostId !== null && sdk !== null && host.primaryHostId !== hostId) {
    try {
      machine = (await sdk.hosts.get({ hostId })).name;
    } catch {
      // unknown machine
    }
  }
  return { cwd, machine, reused };
}

const CHIP_TONE: Record<ChipTone, string> = {
  running: "bg-muted text-muted-foreground",
  success: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  failure: "bg-destructive/15 text-destructive",
  neutral: "bg-muted text-muted-foreground",
};

/** Status chip, output preview and "Open terminal" for the block's last run. */
function RunStatus({
  run,
  showPreview,
  onOpenTerminal,
}: {
  run: RunRecord;
  showPreview: boolean;
  onOpenTerminal: (() => void) | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  const running = run.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const failed = run.status === "done" && run.exitCode !== null && run.exitCode !== 0;
  const [open, setOpen] = useState(failed);
  const [openedForFailure, setOpenedForFailure] = useState(failed);
  if (failed && !openedForFailure) {
    // A run that just failed opens its output once.
    setOpenedForFailure(true);
    setOpen(true);
  }
  const chip = runChip(run, running ? Math.max(now, run.startedAt) : (run.finishedAt ?? now));
  const hasPreview = showPreview && run.preview !== "";
  const lineCount = run.preview === "" ? 0 : run.preview.split("\n").length;

  return (
    <div className="-mt-1 mb-2 text-xs" data-runnable-run-status="">
      <div className="flex flex-wrap items-center gap-1">
        <span
          role="status"
          aria-label={chip.description}
          title={chip.description}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] ${CHIP_TONE[chip.tone]}`}
        >
          {running ? <Icon name="Loader2" fallback="Loader" className="size-3 animate-spin" aria-hidden /> : null}
          {chip.label}
        </span>
        {hasPreview ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-[11px] font-normal text-muted-foreground"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <Icon name={open ? "ChevronDown" : "ChevronRight"} fallback="Code" className="size-3" aria-hidden />
            {open ? "Hide output" : `Output (${lineCount} line${lineCount === 1 ? "" : "s"})`}
          </Button>
        ) : null}
        {onOpenTerminal !== null ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-6 px-1.5 text-[11px] font-normal text-muted-foreground"
            onClick={onOpenTerminal}
          >
            Open terminal
          </Button>
        ) : null}
      </div>
      {hasPreview && open ? (
        <pre
          className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/40 p-2 font-mono text-[11px] leading-snug"
          aria-label="Last lines of output"
          tabIndex={0}
        >
          {run.skipped ? "… (earlier output no longer in the terminal's scrollback)\n" : ""}
          {run.preview}
        </pre>
      ) : null}
    </div>
  );
}

function ToolbarButton({
  icon,
  label,
  ariaLabel,
  onClick,
  disabled,
}: {
  icon: string;
  label: string;
  /** Accessible name; starts with the visible label. */
  ariaLabel: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 gap-1.5 px-2 text-xs font-normal text-muted-foreground"
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon name={icon} fallback="Code" aria-hidden />
      {label}
    </Button>
  );
}

function ConfirmDialog({
  pending,
  command,
  lineCount,
  threadConfirmed,
  settingAskEveryRun,
  onCancel,
  onConfirm,
}: {
  pending: PendingConfirm;
  command: string;
  lineCount: number;
  threadConfirmed: boolean;
  /** The plugin's "Confirm every run" setting is on. */
  settingAskEveryRun: boolean;
  onCancel: () => void;
  onConfirm: (options: { rememberThread: boolean; askEveryRun: boolean }) => void;
}) {
  const store = browserStore();
  const [rememberThread, setRememberThread] = useState(true);
  const [askEveryRun, setAskEvery] = useState(() => getAskEveryRun(store));
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const risky = pending.reason === "risky";
  const fresh = pending.fresh;

  const title = risky
    ? "This command looks risky"
    : pending.reason === "multi-line"
      ? `Run these ${lineCount} lines?`
      : "Run this command?";
  const terminalLabel = fresh
    ? "A new terminal"
    : pending.target === null
      ? "…"
      : pending.target.reused
        ? `“${RUN_TERMINAL_TITLE}” (reused)`
        : `A new “${RUN_TERMINAL_TITLE}” terminal`;
  const folder =
    pending.target === null ? "…" : pending.target.cwd === null ? "The thread's folder" : formatHomePathForDisplay(pending.target.cwd);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent
        className="max-w-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (risky ? cancelRef : confirmRef).current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {risky ? <Icon name="AlertTriangle" className="size-4 text-destructive" aria-hidden /> : null}
            {title}
          </DialogTitle>
          <DialogDescription>
            {risky
              ? "Check what it does before running it. It runs in this thread's terminal with your permissions."
              : "It runs in this thread's terminal with your permissions."}
          </DialogDescription>
        </DialogHeader>

        {risky ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-destructive" aria-label="Why this looks risky">
            {pending.risks.map((risk) => (
              <li key={risk.id}>{risk.label}</li>
            ))}
          </ul>
        ) : null}

        <pre
          className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/50 p-3 font-mono text-xs"
          aria-label="Command"
          tabIndex={0}
        >
          {command}
        </pre>

        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Folder</dt>
          <dd className="truncate font-mono" title={pending.target?.cwd ?? undefined}>
            {folder}
          </dd>
          {pending.target?.machine ? (
            <>
              <dt className="text-muted-foreground">Machine</dt>
              <dd className="truncate">{pending.target.machine}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Terminal</dt>
          <dd className="truncate">{terminalLabel}</dd>
        </dl>

        <div className="flex flex-col gap-2 text-xs text-muted-foreground">
          {!threadConfirmed ? (
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                className="size-3.5 accent-foreground"
                checked={rememberThread}
                onChange={(event) => setRememberThread(event.target.checked)}
              />
              Don't ask again in this thread for single-line commands
            </label>
          ) : null}
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className="size-3.5 accent-foreground"
              checked={askEveryRun || settingAskEveryRun}
              disabled={settingAskEveryRun}
              onChange={(event) => setAskEvery(event.target.checked)}
            />
            {settingAskEveryRun
              ? "Always ask before running (on in the plugin's settings)"
              : "Always ask before running, in every thread (this browser)"}
          </label>
          <p>Multi-line and risky commands always ask.</p>
        </div>

        <DialogFooter>
          <Button ref={cancelRef} type="button" variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            ref={confirmRef}
            type="button"
            variant={risky ? "destructive" : "default"}
            size="sm"
            onClick={() => onConfirm({ rememberThread, askEveryRun })}
          >
            <Icon name="Play" aria-hidden />
            {risky ? "Run anyway" : "Run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RunnableBlock({ code, language, status, index, message, Original }: ExperimentalCodeFenceRendererProps) {
  const sdk = useOptional<PluginBrowserBbSdk>(useSdk);
  const navigate = useOptional<ReturnType<typeof useBbNavigate>>(useBbNavigate);
  const composer = useOptional<ReturnType<typeof useComposer>>(useComposer);
  const context = useOptional<ReturnType<typeof useBbContext>>(useBbContext);
  const settingsState = useOptional<PluginSettingsState>(useSettings);
  const rpc = useOptional<RpcClient>(useRpc);
  const settings = useMemo(() => readSettings(settingsState?.values), [settingsState?.values]);
  const settingAskEveryRun = settings.confirmMode === "every-run";

  const threadId = context?.threadId ?? message.threadId;
  const parsed = useMemo(() => parseBlock(code, language), [code, language]);
  const key = blockKey(message.id, language, index);
  const [ran, setRan] = useState(() => hasRan(browserStore(), key));
  const [run, setRun] = useState<RunRecord | null>(() => getRun(browserStore(), key));
  const [busy, setBusy] = useState(false);
  /** A Run is waiting for its terminal's shell to start. */
  const [starting, setStarting] = useState(false);
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const watchRef = useRef<AbortController | null>(null);

  const terminals: TerminalsApi | null = isTerminalsApi(sdk?.terminals) ? sdk.terminals : null;
  const openTerminal: OpenTerminal | null =
    typeof navigate?.experimental_openTerminal === "function"
      ? navigate.experimental_openTerminal.bind(navigate)
      : null;

  // The latest terminals area, read by `follow` so the watch (and the resume
  // effect) don't restart when the SDK object's identity changes.
  const terminalsRef = useRef(terminals);
  terminalsRef.current = terminals;

  /** Follows a run until it ends or this card unmounts; saves every update. */
  const follow = useCallback(
    (record: RunRecord) => {
      const api = terminalsRef.current;
      if (api === null) return;
      watchRef.current?.abort();
      const controller = new AbortController();
      watchRef.current = controller;
      void watchRun(api, record, {
        signal: controller.signal,
        onUpdate: (next) => {
          saveRun(browserStore(), next);
          if (!controller.signal.aborted) setRun(next);
        },
      });
    },
    [],
  );

  // Resume a run that was still going when this card last unmounted (the
  // stored sequence number picks up where it stopped); give up on old ones.
  useEffect(() => {
    const stored = getRun(browserStore(), key);
    if (stored !== null && stored.status === "running") {
      if (canResume(stored, Date.now())) follow(stored);
      else {
        const stopped: RunRecord = { ...stored, status: "stopped", finishedAt: Date.now() };
        saveRun(browserStore(), stopped);
        setRun(stopped);
      }
    }
    return () => {
      watchRef.current?.abort();
      watchRef.current = null;
    };
  }, [key, follow]);

  const reveal = useCallback(
    async (terminalId: string): Promise<boolean> => {
      if (openTerminal === null) return false;
      try {
        return await openTerminal({ terminalId });
      } catch {
        return false;
      }
    },
    [openTerminal],
  );

  const deliver = useCallback(
    async (action: Action) => {
      if (terminals === null) return;
      setBusy(true);
      setStarting(action !== "insert");
      try {
        const fresh = action === "run-new" || (action === "run" && settings.terminalMode === "new");
        const integrationArgv = await integrationArgvFor(sdk, rpc, threadId, settings.shellIntegration);
        const { terminal, integrated } = await acquireTerminal(terminals, threadId, {
          fresh,
          integrationArgv,
          knownIntegrated: (id) => isKnownIntegrated(browserStore(), id),
          rememberIntegrated: (id) => rememberIntegrated(browserStore(), id),
        });
        const shown = await reveal(terminal.id);
        const runs = action !== "insert";
        // Read the output position before sending, so the watch sees only this run.
        let nextSeq: number | null = null;
        if (runs) {
          try {
            nextSeq = await currentSeq(terminals, terminal.id);
          } catch {
            nextSeq = null;
          }
        }
        await sendCommand(terminals, terminal.id, parsed.command, { run: runs });
        setStarting(false);
        if (runs) {
          markRan(browserStore(), key);
          setRan(true);
          if (nextSeq !== null) {
            const record = startRecord({ key, terminalId: terminal.id, integrated, nextSeq, now: Date.now() });
            saveRun(browserStore(), record);
            setRun(record);
            follow(record);
          }
        }
        if (!shown) {
          toast.info(action === "insert" ? "Inserted in the terminal" : "Sent to the terminal", {
            description: `Open this thread's terminal panel and pick the “${terminal.title}” tab to see it.`,
          });
        }
      } catch (cause) {
        toast.error(action === "insert" ? "Couldn't insert the command" : "Couldn't run the command", {
          description: errorMessage(cause),
        });
      } finally {
        setBusy(false);
        setStarting(false);
      }
    },
    [terminals, reveal, threadId, parsed.command, key, sdk, rpc, settings.terminalMode, settings.shellIntegration, follow],
  );

  const requestRun = useCallback(
    (action: Exclude<Action, "insert">) => {
      if (terminals === null) return;
      const store = browserStore();
      const risks = findRisks(parsed.command, settings.extraRiskyPatterns);
      const reason = confirmReason({
        risks,
        multiLine: parsed.multiLine,
        threadConfirmed: isThreadConfirmed(store, threadId),
        askEveryRun: settingAskEveryRun || getAskEveryRun(store),
      });
      if (reason === null) {
        void deliver(action);
        return;
      }
      const fresh = action === "run-new" || settings.terminalMode === "new";
      setPending({ action, reason, risks, target: null, fresh });
      void integrationArgvFor(sdk, rpc, threadId, settings.shellIntegration)
        .catch(() => null)
        .then((argv) => describeTarget(sdk, terminals, threadId, fresh, argv !== null))
        .then((target) =>
          setPending((current) => (current !== null && current.action === action ? { ...current, target } : current)),
        );
    },
    [terminals, parsed.command, parsed.multiLine, threadId, deliver, sdk, rpc, settings, settingAskEveryRun],
  );

  const insertIntoComposer = useCallback(() => {
    const text = parsed.runnable ? parsed.command : code.trimEnd();
    const body = text.includes("\n") ? `\`\`\`${language}\n${text}\n\`\`\`` : text;
    try {
      if (composer === null) throw new Error("No composer here.");
      composer.insert(body, { at: "end", block: true });
      composer.focus?.();
    } catch (cause) {
      toast.error("Couldn't insert into the composer", { description: errorMessage(cause) });
    }
  }, [composer, parsed.runnable, parsed.command, code, language]);

  if (status === "streaming") return <Original />;
  // Languages turned off in the settings keep bb's plain block.
  if (!settings.languages.includes(language.toLowerCase())) return <Original />;

  const canTerminal = terminals !== null && parsed.runnable;
  const canRun = canTerminal && status === "closed";

  return (
    <div data-runnable-block="">
      <Original />
      <div role="toolbar" aria-label="Shell command actions" className="-mt-1 mb-2 flex flex-wrap items-center gap-0.5">
        {canRun ? (
          <ToolbarButton
            icon="Play"
            label="Run"
            ariaLabel={`Run command in the “${RUN_TERMINAL_TITLE}” terminal`}
            onClick={() => requestRun("run")}
            disabled={busy}
          />
        ) : null}
        {canTerminal ? (
          <ToolbarButton
            icon="SquareTerminal"
            label="Insert into terminal"
            ariaLabel="Insert into terminal without pressing Enter"
            onClick={() => void deliver("insert")}
            disabled={busy}
          />
        ) : null}
        {composer !== null ? (
          <ToolbarButton
            icon="MessageSquarePlus"
            label="Insert into composer"
            ariaLabel="Insert into composer draft"
            onClick={insertIntoComposer}
          />
        ) : null}
        {canRun ? (
          <ToolbarButton
            icon="Plus"
            label="Run in new terminal"
            ariaLabel="Run in new terminal tab"
            onClick={() => requestRun("run-new")}
            disabled={busy}
          />
        ) : null}
        {ran ? (
          <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            <Icon name="Check" className="size-3" aria-hidden />
            Ran
          </span>
        ) : null}
      </div>
      {starting ? (
        <div className="-mt-1 mb-2 text-xs">
          <span
            role="status"
            className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
          >
            <Icon name="Loader2" fallback="Loader" className="size-3 animate-spin" aria-hidden />
            Starting terminal…
          </span>
        </div>
      ) : run !== null ? (
        <RunStatus
          run={run}
          showPreview={settings.showOutputPreview}
          onOpenTerminal={
            openTerminal === null
              ? null
              : () => {
                  void reveal(run.terminalId).then((shown) => {
                    if (!shown) toast.info("Couldn't open that terminal", { description: "It may have been closed." });
                  });
                }
          }
        />
      ) : null}
      {pending !== null ? (
        <ConfirmDialog
          pending={pending}
          command={parsed.command}
          lineCount={parsed.command.split("\n").length}
          threadConfirmed={isThreadConfirmed(browserStore(), threadId)}
          settingAskEveryRun={settingAskEveryRun}
          onCancel={() => setPending(null)}
          onConfirm={({ rememberThread, askEveryRun }) => {
            const store = browserStore();
            setAskEveryRun(store, askEveryRun);
            if (rememberThread) setThreadConfirmed(store, threadId, true);
            const action = pending.action;
            setPending(null);
            void deliver(action);
          }}
        />
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  const register = app.slots?.experimental_codeFenceRenderer;
  if (typeof register !== "function") {
    console.warn("[runnable-blocks] This bb has no experimental_codeFenceRenderer slot; code blocks stay as they are.");
    return;
  }
  register.call(app.slots, {
    id: "shell",
    languages: SHELL_LANGUAGES,
    component: RunnableBlock,
  });
});
