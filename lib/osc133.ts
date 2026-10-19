// Reads OSC 133 ("FinalTerm" / semantic prompt) marks out of terminal output.
//
// A shell with integration prints, around each command line:
//   OSC 133;A  prompt starts        OSC 133;B  prompt ends (input starts)
//   OSC 133;C  command output starts
//   OSC 133;D;<exit code>  command finished
// (OSC = ESC ] ... terminated by BEL or ST = ESC \.) VS Code, iTerm2, Warp and
// WezTerm use the same marks.
//
// `Osc133Parser` is a streaming state machine over decoded text: feed it
// chunks in order, split anywhere (even inside an escape sequence). It strips
// every escape sequence (colors, cursor moves, titles, hyperlinks) from the
// output it keeps, applies CR/LF and backspace the way a terminal would for a
// single line, and records each C..D run with its exit code and the tail of
// its output.
//
// Two modes:
// - "osc133": a run starts at C and ends at D;<code>.
// - "paste": fallback for shells without integration. A run starts when the
//   line editor turns bracketed paste off (it accepted a line, CSI ?2004l)
//   and ends when it turns it back on at the next prompt (CSI ?2004h). There
//   is no exit code.
//
// Pure and dependency-free so it runs under `node --test`.

export const PREVIEW_LINES = 20;
export const PREVIEW_MAX_CHARS = 4096;
/** Completed lines kept while a run streams (only the tail is ever shown). */
const KEEP_LINES = 200;
/** Longest single line kept; the rest of a huge line is dropped. */
const MAX_LINE_CHARS = 1000;
/** Longest OSC payload buffered; longer ones (inline images) are skipped. */
const MAX_OSC_CHARS = 512;
/** Completed runs remembered. */
const MAX_RUNS = 20;

export type ParserMode = "osc133" | "paste";
export type Phase = "idle" | "running";

export interface RunResult {
  /** Exit code from D;<code>, or null when the mark had none (or paste mode). */
  exitCode: number | null;
  /** Last lines of the run's output, escapes stripped (see `buildPreview`). */
  preview: string;
}

export interface ParserOptions {
  mode?: ParserMode;
  /** Resume mid-run: start in "running" with these output lines already seen. */
  phase?: Phase;
  seedLines?: readonly string[];
}

type EscState =
  | "text"
  | "esc" // saw ESC
  | "esc-int" // ESC + intermediate bytes (charset selection etc.)
  | "csi"
  | "osc"
  | "osc-esc" // ESC inside an OSC: maybe ST
  | "str" // DCS / SOS / PM / APC payload: skipped until ST
  | "str-esc";

const ESC = "\u001b";
const BEL = "\u0007";

/** Keeps the last `PREVIEW_LINES` lines, at most `PREVIEW_MAX_CHARS` characters. */
export function buildPreview(lines: readonly string[]): string {
  const trimmed = [...lines];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1]!.trim() === "") trimmed.pop();
  while (trimmed.length > 0 && trimmed[0]!.trim() === "") trimmed.shift();
  let text = trimmed.slice(-PREVIEW_LINES).join("\n");
  if (text.length > PREVIEW_MAX_CHARS) {
    text = text.slice(text.length - PREVIEW_MAX_CHARS);
    const cut = text.indexOf("\n");
    // Drop the partial first line when there's a later full one.
    if (cut !== -1 && cut < text.length - 1) text = text.slice(cut + 1);
  }
  return text;
}

/** Strips escape sequences and control characters from a finished string (tests, previews). */
export function stripAnsi(text: string): string {
  const parser = new Osc133Parser({ phase: "running" });
  parser.feed(text);
  return parser.currentLines().join("\n");
}

export class Osc133Parser {
  readonly mode: ParserMode;
  private esc: EscState = "text";
  private csiBuf = "";
  private oscBuf = "";
  private oscOverflow = false;
  private pendingCR = false;
  private phaseValue: Phase;
  private lines: string[];
  private line = "";
  private readonly done: RunResult[] = [];
  /** Total runs completed, including ones dropped from `runs`. */
  private completedCount = 0;

  constructor({ mode = "osc133", phase = "idle", seedLines = [] }: ParserOptions = {}) {
    this.mode = mode;
    this.phaseValue = phase;
    this.lines = phase === "running" ? seedLines.slice(-KEEP_LINES) : [];
  }

  get phase(): Phase {
    return this.phaseValue;
  }

  /** Completed runs, oldest first. */
  get runs(): readonly RunResult[] {
    return this.done;
  }

  get completed(): number {
    return this.completedCount;
  }

  /** Output lines of the run in progress (the partial last line included). */
  currentLines(): string[] {
    return this.line === "" ? [...this.lines] : [...this.lines, this.line];
  }

  /** Preview of the run in progress. */
  currentPreview(): string {
    return buildPreview(this.currentLines());
  }

  feed(text: string): void {
    for (const ch of text) this.step(ch);
  }

  private step(ch: string): void {
    switch (this.esc) {
      case "text":
        return this.text(ch);
      case "esc":
        return this.afterEsc(ch);
      case "esc-int":
        // Intermediates 0x20-0x2F, then one final byte ends the sequence.
        if (ch >= " " && ch <= "/") return;
        this.esc = "text";
        if (ch === ESC) this.esc = "esc";
        return;
      case "csi":
        return this.csi(ch);
      case "osc":
        return this.osc(ch);
      case "osc-esc":
        if (ch === "\\") {
          this.finishOsc();
          this.esc = "text";
          return;
        }
        // ESC inside an OSC that isn't ST: the OSC was cut short. Drop it and
        // read this as a new escape sequence (a nested OSC starts over).
        this.oscBuf = "";
        this.oscOverflow = false;
        this.esc = "esc";
        return this.afterEsc(ch);
      case "str":
        if (ch === ESC) this.esc = "str-esc";
        else if (ch === BEL || ch === "\u009c") this.esc = "text";
        return;
      case "str-esc":
        this.esc = ch === "\\" ? "text" : "str";
        return;
    }
  }

  private afterEsc(ch: string): void {
    switch (ch) {
      case "[":
        this.esc = "csi";
        this.csiBuf = "";
        return;
      case "]":
        this.startOsc();
        return;
      case "P":
      case "X":
      case "^":
      case "_":
        this.esc = "str";
        return;
      case ESC:
        this.esc = "esc";
        return;
      default:
        if (ch >= " " && ch <= "/") {
          this.esc = "esc-int";
          return;
        }
        // Two-byte sequence (ESC 7, ESC =, ESC M, ...): ignored.
        this.esc = "text";
    }
  }

  private csi(ch: string): void {
    const code = ch.codePointAt(0)!;
    if (code >= 0x40 && code <= 0x7e) {
      this.finishCsi(this.csiBuf, ch);
      this.esc = "text";
      return;
    }
    if (ch === ESC) {
      // Malformed: a new sequence starts.
      this.esc = "esc";
      return;
    }
    if (code < 0x20) {
      // C0 controls inside CSI execute; CAN/SUB abort.
      if (ch === "\u0018" || ch === "\u001a") this.esc = "text";
      return;
    }
    if (this.csiBuf.length < 64) this.csiBuf += ch;
  }

  private finishCsi(params: string, final: string): void {
    if (this.mode !== "paste" || params !== "?2004") return;
    if (final === "l" && this.phaseValue === "idle") this.begin();
    else if (final === "h" && this.phaseValue === "running") this.end(null);
  }

  private startOsc(): void {
    this.esc = "osc";
    this.oscBuf = "";
    this.oscOverflow = false;
  }

  private osc(ch: string): void {
    if (ch === BEL || ch === "\u009c") {
      this.finishOsc();
      this.esc = "text";
      return;
    }
    if (ch === ESC) {
      this.esc = "osc-esc";
      return;
    }
    if (ch === "\u0018" || ch === "\u001a") {
      this.esc = "text";
      return;
    }
    if (this.oscBuf.length < MAX_OSC_CHARS) this.oscBuf += ch;
    else this.oscOverflow = true;
  }

  private finishOsc(): void {
    const payload = this.oscBuf;
    const overflow = this.oscOverflow;
    this.oscBuf = "";
    this.oscOverflow = false;
    if (overflow || this.mode !== "osc133" || !payload.startsWith("133;")) return;
    const fields = payload.slice(4).split(";");
    const kind = fields[0];
    if (kind === "C") {
      // A C while running means the D was lost; start over.
      this.begin();
    } else if (kind === "D" && this.phaseValue === "running") {
      const raw = fields[1];
      const exitCode = raw !== undefined && /^-?\d{1,10}$/.test(raw) ? Number.parseInt(raw, 10) : null;
      this.end(exitCode);
    }
  }

  private begin(): void {
    this.phaseValue = "running";
    this.lines = [];
    this.line = "";
    this.pendingCR = false;
  }

  private end(exitCode: number | null): void {
    this.flushCR();
    this.done.push({ exitCode, preview: this.currentPreview() });
    if (this.done.length > MAX_RUNS) this.done.shift();
    this.completedCount++;
    this.phaseValue = "idle";
    this.lines = [];
    this.line = "";
  }

  private flushCR(): void {
    if (!this.pendingCR) return;
    // A lone CR returns to column 0: the next text overwrites the line.
    // Approximated as clearing it (progress bars redraw whole lines).
    this.pendingCR = false;
    this.line = "";
  }

  private text(ch: string): void {
    // 8-bit C1 forms of the introducers.
    switch (ch) {
      case ESC:
        this.esc = "esc";
        return;
      case "\u009b":
        this.esc = "csi";
        this.csiBuf = "";
        return;
      case "\u009d":
        this.startOsc();
        return;
      case "\u0090":
      case "\u0098":
      case "\u009e":
      case "\u009f":
        this.esc = "str";
        return;
    }
    if (this.phaseValue !== "running") return;
    if (ch === "\n") {
      this.pendingCR = false;
      this.pushLine();
      return;
    }
    if (ch === "\r") {
      this.pendingCR = true;
      return;
    }
    this.flushCR();
    if (ch === "\b") {
      this.line = this.line.slice(0, -1);
      return;
    }
    const code = ch.codePointAt(0)!;
    if (ch !== "\t" && (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f))) return;
    if (this.line.length < MAX_LINE_CHARS) this.line += ch;
  }

  private pushLine(): void {
    this.lines.push(this.line);
    this.line = "";
    if (this.lines.length > KEEP_LINES) this.lines.splice(0, this.lines.length - KEEP_LINES);
  }
}
