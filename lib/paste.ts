// Builds the bytes sent to a terminal.
//
// Commands go in as a bracketed paste (ESC[200~ ... ESC[201~), so a shell
// line editor that supports it (zsh, bash 5.1+, fish) takes a multi-line
// block or heredoc as one unit instead of running it line by line. Run adds
// a carriage return after the paste; Insert does not.
//
// The payload comes from a model reply, so it is treated as hostile: a
// literal ESC[201~ inside it would end the paste early and let the rest run
// as typed keys. Every ESC and other control character except tab and
// newline is removed before wrapping.

export const PASTE_START = "\u001b[200~";
export const PASTE_END = "\u001b[201~";

/**
 * Removes paste delimiters and control characters, and normalizes line
 * endings to `\n`. Keeps tab and newline.
 */
export function sanitizePayload(text: string): string {
  let out = text.replace(/\r\n?/g, "\n");
  // Repeat so a delimiter rebuilt by removing an inner one is removed too.
  let previous: string;
  do {
    previous = out;
    out = out.split(PASTE_START).join("").split(PASTE_END).join("");
  } while (out !== previous);
  // C0 controls except \t (0x09) and \n (0x0a), DEL, and C1 controls
  // (U+0080..U+009F, which some terminals treat as 8-bit CSI/OSC).
  return out.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

export interface PasteOptions {
  /** Press Enter after the paste. */
  run: boolean;
}

/** The exact string to write to the terminal. */
export function buildPaste(command: string, { run }: PasteOptions): string {
  return `${PASTE_START}${sanitizePayload(command)}${PASTE_END}${run ? "\r" : ""}`;
}

/** Base64 of the UTF-8 bytes of `text`. Works in browsers and Node. */
export function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Decodes base64 to a UTF-8 string, replacing invalid sequences. */
export function fromBase64Utf8(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** `buildPaste` encoded for `terminals.input({ dataBase64 })`. */
export function encodePaste(command: string, options: PasteOptions): string {
  return toBase64Utf8(buildPaste(command, options));
}

const PASTE_MODE_ON = "\u001b[?2004h";
const PASTE_MODE_OFF = "\u001b[?2004l";

/**
 * Reads the shell's bracketed-paste mode from recent terminal output.
 *
 * Line editors turn the mode on when they show a prompt and off while a
 * command runs, so the last marker tells whether the shell is waiting for
 * input ("on"), busy ("off"), or doesn't say ("unknown": an older shell, or
 * the marker scrolled out of the tail).
 */
export function pasteModeFromOutput(output: string): "on" | "off" | "unknown" {
  const on = output.lastIndexOf(PASTE_MODE_ON);
  const off = output.lastIndexOf(PASTE_MODE_OFF);
  if (on === -1 && off === -1) return "unknown";
  return on > off ? "on" : "off";
}
