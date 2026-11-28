import { originPattern } from '../core/providers';
import { builtinProblem, type BuiltinAvailability } from '../core/providers/chromeBuiltin';
import type { InBrowserState } from '../core/providers/inBrowserModel';
import { describeShortcut } from '../core/shortcuts';
import type { Connection, Settings } from '../core/types';

export const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.userAgent);
export const BASE_TITLE = document.title;
export const UNSAVED_NOTICE = 'Unsaved changes — click Save to keep them.';
export const DEFAULT_ACTION_COMMAND = 'run-default-action';
export const BUILTIN_POLL_MS = 5_000;
export const BUILTIN_STALL_MS = 120_000;

export interface OptionsStore {
  settings: Settings;
  savedSnapshot: string;
  /** True when settings were just imported from a backup file and not yet saved. */
  importedPending: boolean;
  /** True while `save()` is in flight, preventing duplicate saves or storage reload races. */
  saving: boolean;
  footerStatus: HTMLElement | null;
  unsavedNoticeShown: boolean;
  expandedConnectionId: string | null;
  openAdvancedIds: Set<string>;
  openActionIds: Set<string>;
  liveTimingOpen: boolean;
  firstChoiceAccountOpen: boolean;
  builtinState: BuiltinAvailability | null;
  builtinDownload: { fraction: number; movedAt: number } | null;
  builtinDownloadPoll: ReturnType<typeof setInterval> | undefined;
  builtinBgPoll: ReturnType<typeof setTimeout> | undefined;
  builtinDownloadError: string | null;
  localFinder: { searching: boolean; lines: string[]; kind: 'ok' | 'error' | 'info' } | null;
  inBrowserState: InBrowserState | null;
  inBrowserPoll: ReturnType<typeof setTimeout> | undefined;
  backupIncludeSecrets: boolean;
  backupNotice: { text: string; kind: 'ok' | 'error' | 'warn' } | null;
  shortcutNotice: { actionId: string; text: string; kind: 'ok' | 'error' } | null;
  /** CSS selector to restore focus to after a re-render. */
  pendingFocusSelector: string | null;
  layoutMap: Map<string, string> | null;
  commandChords: { name: string; chord: string; label: string }[];
  cancelRecording: (() => void) | null;
  render: () => void;
  refreshUnsaved: () => void;
}

export const store: OptionsStore = {
  settings: undefined as unknown as Settings,
  savedSnapshot: '',
  importedPending: false,
  saving: false,
  footerStatus: null,
  unsavedNoticeShown: false,
  expandedConnectionId: null,
  openAdvancedIds: new Set<string>(),
  openActionIds: new Set<string>(),
  liveTimingOpen: false,
  firstChoiceAccountOpen: false,
  builtinState: null,
  builtinDownload: null,
  builtinDownloadPoll: undefined,
  builtinBgPoll: undefined,
  builtinDownloadError: null,
  localFinder: null,
  inBrowserState: null,
  inBrowserPoll: undefined,
  backupIncludeSecrets: false,
  backupNotice: null,
  shortcutNotice: null,
  pendingFocusSelector: null,
  layoutMap: null,
  commandChords: [],
  cancelRecording: null,
  render: () => {},
  refreshUnsaved: () => {},
};

export function isDirty(): boolean {
  return JSON.stringify(store.settings) !== store.savedSnapshot;
}

export function shortcutLabel(chord: string): string {
  return describeShortcut(chord, { mac: IS_MAC, layout: store.layoutMap });
}

export function openShortcutSettings(): void {
  void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
}

export function builtinCardProblem(connection: Connection): string | null {
  if (connection.transport !== 'chrome_builtin' || !store.builtinState) return null;
  return builtinProblem(store.builtinDownload ? 'downloading' : store.builtinState);
}

/**
 * Host access is requested here, from a click, rather than declared in the
 * manifest — so the extension only ever holds permission for endpoints the user
 * actually configured.
 */
export async function ensureOriginPermission(connection: Connection): Promise<boolean> {
  if (connection.transport === 'chrome_builtin' || connection.transport === 'in_browser') return true;
  const pattern = originPattern(connection);
  if (!pattern) return false;
  return chrome.permissions.request({ origins: [pattern] });
}
