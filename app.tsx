// Runnable Blocks — frontend.
//
// Claims bash/sh/zsh/shell/console fences in assistant replies. Each fence
// renders bb's own code block (<Original/>) unchanged, plus a small toolbar
// once the fence has closed:
//   Run · Insert into terminal · Insert into composer · Run in new terminal
//
// Nothing runs without a click. Run confirms the first time in a thread, for
// every multi-line block, and for risky commands (explicit "Run anyway").
// Commands go to the thread's "Run blocks" terminal as a sanitized bracketed
// paste, then the terminal is revealed in the side panel.
//
// Experimental APIs are feature-checked so an older or newer bb degrades to
// bb's plain code block or to Insert-only instead of throwing.
import { useCallback, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useComposer,
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
import { parseBlock, SHELL_LANGUAGES } from "./lib/parse.ts";
import { findRisks, type Risk } from "./lib/risk.ts";
import {
  blockKey,
  browserStore,
  getAskEveryRun,
  hasRan,
  isThreadConfirmed,
  markRan,
  setAskEveryRun,
  setThreadConfirmed,
} from "./lib/state.ts";
import {
  acquireTerminal,
  findReusable,
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

/** Best-effort folder and machine for the confirmation dialog. Never throws. */
async function describeTarget(
  sdk: PluginBrowserBbSdk | null,
  api: TerminalsApi,
  threadId: string,
  fresh: boolean,
): Promise<Target> {
  let cwd: string | null = null;
  let hostId: string | null = null;
  let reused = false;
  if (!fresh) {
    try {
      const terminal = await findReusable(api, threadId);
      if (terminal !== null) {
        cwd = terminal.initialCwd;
        hostId = terminal.hostId;
        reused = true;
      }
    } catch {
      // fall through to the thread's environment
    }
  }
  if (cwd === null && sdk !== null) {
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
  }
  let machine: string | null = null;
  if (hostId !== null && sdk !== null) {
    try {
      const [config, host] = await Promise.all([sdk.system.config(), sdk.hosts.get({ hostId })]);
      if (config.primaryHostId !== hostId) machine = host.name;
    } catch {
      // unknown machine
    }
  }
  return { cwd, machine, reused };
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
  const fresh = pending.action === "run-new";

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
  const settings = useOptional<PluginSettingsState>(useSettings);
  const settingAskEveryRun = settings?.values?.confirmEveryRun === true;

  const threadId = context?.threadId ?? message.threadId;
  const parsed = useMemo(() => parseBlock(code, language), [code, language]);
  const key = blockKey(message.id, language, index);
  const [ran, setRan] = useState(() => hasRan(browserStore(), key));
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const terminals: TerminalsApi | null = isTerminalsApi(sdk?.terminals) ? sdk.terminals : null;
  const openTerminal: OpenTerminal | null =
    typeof navigate?.experimental_openTerminal === "function"
      ? navigate.experimental_openTerminal.bind(navigate)
      : null;

  const deliver = useCallback(
    async (action: Action) => {
      if (terminals === null) return;
      setBusy(true);
      try {
        const { terminal } = await acquireTerminal(terminals, threadId, { fresh: action === "run-new" });
        let shown = false;
        if (openTerminal !== null) {
          try {
            shown = await openTerminal({ terminalId: terminal.id });
          } catch {
            shown = false;
          }
        }
        await sendCommand(terminals, terminal.id, parsed.command, { run: action !== "insert" });
        if (action !== "insert") {
          markRan(browserStore(), key);
          setRan(true);
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
      }
    },
    [terminals, openTerminal, threadId, parsed.command, key],
  );

  const requestRun = useCallback(
    (action: Exclude<Action, "insert">) => {
      if (terminals === null) return;
      const store = browserStore();
      const risks = findRisks(parsed.command);
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
      setPending({ action, reason, risks, target: null });
      void describeTarget(sdk, terminals, threadId, action === "run-new").then((target) =>
        setPending((current) => (current !== null && current.action === action ? { ...current, target } : current)),
      );
    },
    [terminals, parsed.command, parsed.multiLine, threadId, deliver, sdk, settingAskEveryRun],
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
