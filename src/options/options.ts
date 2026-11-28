import { normalizeOrigin, originMatchPattern } from '../core/browser';
import { normalizeBaseUrl } from '../core/presets';
import { originPattern, validateConnection } from '../core/providers';
import { builtinAvailability } from '../core/providers/chromeBuiltin';
import { parseCommandShortcut } from '../core/shortcuts';
import {
  connectionChain,
  loadSettings,
  mergeOnSave,
  saveSettings,
  SETTINGS_STORAGE_KEY,
} from '../core/storage';
import type { Settings } from '../core/types';
import { renderConnections } from './connections';
import { button, clear, el } from './dom';
import { renderActions, renderBackup, renderLiveCheck, renderProfile, renderReports } from './sections';
import { BASE_TITLE, builtinCardProblem, isDirty, store, UNSAVED_NOTICE } from './state';

const app = document.querySelector<HTMLDivElement>('#app')!;

store.render = render;
store.refreshUnsaved = refreshUnsaved;

void init();

async function init(): Promise<void> {
  store.settings = await loadSettings();
  store.savedSnapshot = JSON.stringify(store.settings);
  store.expandedConnectionId = store.settings.activeConnectionId;

  await Promise.all([
    loadLayoutMap(),
    loadCommandChords(),
    builtinAvailability().then((state) => (store.builtinState = state)),
  ]);
  render();
  watchUnsavedChanges();

  // Re-read browser shortcut bindings when returning from chrome://extensions/shortcuts.
  window.addEventListener('focus', () => void refreshCommandChords());

  // Stay in sync with worker-side updates (toolbar live-check toggle, dictionary
  // additions, retired-model moves) whenever the page has no unsaved edits.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(SETTINGS_STORAGE_KEY in changes)) return;
    if (store.saving || store.cancelRecording || isDirty()) return;
    void loadSettings().then((fresh) => {
      if (store.saving || store.cancelRecording || isDirty()) return;
      // The echo of this page's own Save: nothing new to show, and a redraw
      // would wipe the "Saved." line.
      if (JSON.stringify(fresh) === store.savedSnapshot) return;
      store.settings = fresh;
      store.savedSnapshot = JSON.stringify(fresh);
      if (!fresh.connections.some((c) => c.id === store.expandedConnectionId)) {
        store.expandedConnectionId = fresh.activeConnectionId;
      }
      render();
    });
  });
}

async function refreshCommandChords(): Promise<void> {
  const before = JSON.stringify(store.commandChords);
  await loadCommandChords();
  if (JSON.stringify(store.commandChords) !== before && !store.cancelRecording) render();
}

function refreshUnsaved(): void {
  const dirty = isDirty();
  document.title = dirty ? `● ${BASE_TITLE}` : BASE_TITLE;
  const footer = store.footerStatus?.parentElement;
  footer?.classList.toggle('footer--dirty', dirty);
  if (!store.footerStatus) return;
  if (dirty) {
    store.footerStatus.className = 'status status--warn';
    store.footerStatus.textContent = UNSAVED_NOTICE;
    store.unsavedNoticeShown = true;
  } else if (!dirty && store.unsavedNoticeShown) {
    store.footerStatus.className = 'status';
    store.footerStatus.textContent = '';
    store.unsavedNoticeShown = false;
  }
}

function watchUnsavedChanges(): void {
  for (const type of ['input', 'change', 'click']) {
    app.addEventListener(type, () => setTimeout(refreshUnsaved, 0));
  }
  window.addEventListener('beforeunload', (event) => {
    if (isDirty()) event.preventDefault();
  });
  refreshUnsaved();
}

async function loadLayoutMap(): Promise<void> {
  const keyboard = (
    navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }
  ).keyboard;
  try {
    store.layoutMap = (await keyboard?.getLayoutMap?.()) ?? null;
  } catch {
    store.layoutMap = null;
  }
}

async function loadCommandChords(): Promise<void> {
  try {
    const commands = await chrome.commands.getAll();
    store.commandChords = commands.flatMap((command) => {
      const chord = parseCommandShortcut(command.shortcut ?? '');
      if (!chord) return [];
      return [
        {
          name: command.name ?? '',
          chord,
          label: command.description || command.name || 'a ProofKey command',
        },
      ];
    });
  } catch {
    store.commandChords = [];
  }
}

function render(): void {
  // Never leave global capture-phase shortcut recorder listeners orphaned when
  // an async poll or download triggers a re-render.
  store.cancelRecording?.();

  clear(app);
  app.append(
    renderConnections(),
    renderProfile(),
    renderActions(),
    renderLiveCheck(),
    renderBackup(),
    renderReports(),
    renderFooter(),
  );

  if (store.pendingFocusSelector) {
    const target = app.querySelector<HTMLElement>(store.pendingFocusSelector);
    target?.focus();
    store.pendingFocusSelector = null;
  }
  if (store.savedSnapshot) refreshUnsaved();
}

function renderFooter(): HTMLElement {
  const status = el('span', {
    class: 'status',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  store.footerStatus = status;
  store.unsavedNoticeShown = false;

  const saveBtn = button('Save', () => void save(saveBtn), 'primary');

  return el('footer', { class: 'footer' }, status, saveBtn);
}

async function save(saveBtn: HTMLButtonElement): Promise<void> {
  if (store.saving) return;

  // Refuse to silently discard invalid JSON or out-of-range numeric drafts.
  const firstInvalid = app.querySelector<HTMLElement>('.input--invalid');
  if (firstInvalid) {
    firstInvalid.closest('details')?.setAttribute('open', '');
    firstInvalid.focus();
    if (store.footerStatus) {
      store.footerStatus.className = 'status status--error';
      store.footerStatus.textContent = 'Fix the highlighted field before saving.';
    }
    return;
  }

  store.saving = true;
  saveBtn.disabled = true;
  if (store.footerStatus) {
    store.footerStatus.className = 'status';
    store.footerStatus.textContent = 'Saving…';
  }

  try {
    const beforeNormalize = JSON.stringify(store.settings);

    for (const connection of store.settings.connections) {
      connection.baseUrl = normalizeBaseUrl(connection.baseUrl);
    }

    store.settings.shortcutOrigins = [
      ...new Set(store.settings.shortcutOrigins.map(normalizeOrigin).filter((o): o is string => !!o)),
    ];
    const { liveCheck } = store.settings;
    liveCheck.enabledOrigins = [
      ...new Set(liveCheck.enabledOrigins.map(normalizeOrigin).filter((o): o is string => !!o)),
    ];
    liveCheck.blockedOrigins = [
      ...new Set(liveCheck.blockedOrigins.map(normalizeOrigin).filter((o): o is string => !!o)),
    ];
    const liveOrigins = liveCheck.enabledOrigins.filter((o) => !liveCheck.blockedOrigins.includes(o));

    const patterns = [
      ...new Set(
        [
          ...store.settings.connections.map(originPattern),
          ...store.settings.shortcutOrigins.map(originMatchPattern),
          ...liveOrigins.map(originMatchPattern),
        ].filter((p): p is string => !!p),
      ),
    ];
    let sitesGranted = true;
    if (patterns.length > 0) {
      try {
        await chrome.permissions.request({ origins: patterns });
      } catch {
        // Declining is a legitimate choice; the settings still save.
      }
    }

    const sitePatterns = [...store.settings.shortcutOrigins, ...liveOrigins]
      .map(originMatchPattern)
      .filter((p): p is string => !!p);
    if (sitePatterns.length > 0) {
      sitesGranted = await chrome.permissions
        .contains({ origins: sitePatterns })
        .catch(() => false);
    }

    mergeOnSave(
      store.settings,
      JSON.parse(store.savedSnapshot) as Settings,
      await loadSettings(),
      { preserveFrameOrigins: store.importedPending },
    );
    await saveSettings(store.settings);
    store.importedPending = false;
    store.savedSnapshot = JSON.stringify(store.settings);

    // Re-render if normalisation or merging changed anything, so textareas
    // and card warnings match what was actually saved.
    if (store.savedSnapshot !== beforeNormalize) render();

    const status = store.footerStatus;
    store.unsavedNoticeShown = false;
    document.title = BASE_TITLE;
    status?.parentElement?.classList.remove('footer--dirty');
    const usable = connectionChain(store.settings).some(
      (c) => validateConnection(c) === null && builtinCardProblem(c) === null,
    );
    if (status) {
      status.className = usable && sitesGranted ? 'status status--ok' : 'status status--error';
      status.textContent = !usable
        ? 'Saved, but no provider is usable yet — check the warnings above.'
        : sitesGranted
          ? 'Saved.'
          : 'Saved, but access to some sites was not granted, so shortcuts and live checking will not start there on their own.';
    }
  } catch (error) {
    if (store.footerStatus) {
      store.footerStatus.className = 'status status--error';
      store.footerStatus.textContent = `Could not save: ${error instanceof Error ? error.message : String(error)}`;
    }
  } finally {
    store.saving = false;
    if (saveBtn.isConnected) saveBtn.disabled = false;
  }
}
