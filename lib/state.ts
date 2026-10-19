// Small persisted state: which blocks ran, which threads already confirmed a
// first run, and the "ask before every run" toggle. Takes any
// localStorage-like store so it can be tested without a browser.

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const RAN_KEY = "runnable-blocks:ran";
export const CONFIRMED_THREADS_KEY = "runnable-blocks:confirmed-threads";
export const ASK_EVERY_RUN_KEY = "runnable-blocks:ask-every-run";
export const INTEGRATED_TERMINALS_KEY = "runnable-blocks:integrated-terminals";
/** Most integrated terminal ids remembered. */
export const INTEGRATED_TERMINALS_CAP = 100;

/** Most "Ran" badges kept; the oldest are dropped first. */
export const RAN_CAP = 500;
/** Most threads remembered as confirmed. */
export const CONFIRMED_CAP = 200;

/** `${message.id}#${language}#${index}`, the key bb documents for per-fence state. */
export function blockKey(messageId: string, language: string, index: number): string {
  return `${messageId}#${language}#${index}`;
}

function readList(store: KeyValueStore | null, key: string): string[] {
  if (store === null) return [];
  try {
    const raw = store.getItem(key);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function addToList(store: KeyValueStore | null, key: string, value: string, cap: number): void {
  if (store === null) return;
  const list = readList(store, key).filter((item) => item !== value);
  list.push(value);
  const capped = list.slice(Math.max(0, list.length - cap));
  try {
    store.setItem(key, JSON.stringify(capped));
  } catch {
    // Storage full or blocked: badges and memory are a convenience only.
  }
}

function removeFromList(store: KeyValueStore | null, key: string, value: string): void {
  if (store === null) return;
  const list = readList(store, key);
  if (!list.includes(value)) return;
  try {
    store.setItem(key, JSON.stringify(list.filter((item) => item !== value)));
  } catch {
    // ignore
  }
}

export function hasRan(store: KeyValueStore | null, key: string): boolean {
  return readList(store, RAN_KEY).includes(key);
}

export function markRan(store: KeyValueStore | null, key: string): void {
  addToList(store, RAN_KEY, key, RAN_CAP);
}

export function isThreadConfirmed(store: KeyValueStore | null, threadId: string): boolean {
  return readList(store, CONFIRMED_THREADS_KEY).includes(threadId);
}

export function setThreadConfirmed(store: KeyValueStore | null, threadId: string, confirmed: boolean): void {
  if (confirmed) addToList(store, CONFIRMED_THREADS_KEY, threadId, CONFIRMED_CAP);
  else removeFromList(store, CONFIRMED_THREADS_KEY, threadId);
}

/** Terminals this plugin started with shell integration. */
export function isKnownIntegrated(store: KeyValueStore | null, terminalId: string): boolean {
  return readList(store, INTEGRATED_TERMINALS_KEY).includes(terminalId);
}

export function rememberIntegrated(store: KeyValueStore | null, terminalId: string): void {
  addToList(store, INTEGRATED_TERMINALS_KEY, terminalId, INTEGRATED_TERMINALS_CAP);
}

export function getAskEveryRun(store: KeyValueStore | null): boolean {
  try {
    return store?.getItem(ASK_EVERY_RUN_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAskEveryRun(store: KeyValueStore | null, value: boolean): void {
  try {
    store?.setItem(ASK_EVERY_RUN_KEY, value ? "1" : "0");
  } catch {
    // ignore
  }
}

/** The page's localStorage, or null where it is missing or blocked. */
export function browserStore(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
