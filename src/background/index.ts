import { injectFiles, isInjectableUrl } from '../core/browser';
import type {
  ContentRequest,
  ContentState,
  Result,
  RunResult,
  WorkerRequest,
} from '../core/messages';
import { composeExplainPrompt, composeSystemPrompt } from '../core/prompts';
import { runCompletion, validateConnection } from '../core/providers';
import { connectionChain, findAction, loadSettings, resolveActions } from '../core/storage';

const MENU_ROOT = 'proofkey:root';
const MENU_ACTION_PREFIX = 'proofkey:action:';
const MENU_SETTINGS = 'proofkey:settings';
const CONTENT_SCRIPT = 'content.js';

// ---------------------------------------------------------------- lifecycle

chrome.runtime.onInstalled.addListener((details) => {
  void rebuildContextMenus();
  // Nothing works until a provider exists, so send first-time users straight there.
  if (details.reason === 'install') void chrome.runtime.openOptionsPage();
});

// Menu labels come from the user's actions, so they have to follow edits.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'sync') void rebuildContextMenus();
});

async function rebuildContextMenus(): Promise<void> {
  await chrome.contextMenus.removeAll();
  const settings = await loadSettings();

  chrome.contextMenus.create({
    id: MENU_ROOT,
    title: 'ProofKey',
    contexts: ['selection', 'editable'],
  });

  for (const action of resolveActions(settings)) {
    if (!action.enabled) continue;
    chrome.contextMenus.create({
      id: `${MENU_ACTION_PREFIX}${action.id}`,
      parentId: MENU_ROOT,
      title: action.label,
      contexts: ['selection', 'editable'],
    });
  }

  chrome.contextMenus.create({
    id: `${MENU_ROOT}:sep`,
    parentId: MENU_ROOT,
    type: 'separator',
    contexts: ['selection', 'editable'],
  });
  chrome.contextMenus.create({
    id: MENU_SETTINGS,
    parentId: MENU_ROOT,
    title: 'Settings…',
    contexts: ['selection', 'editable'],
  });
}

// ------------------------------------------------------------- entry points

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_SETTINGS) {
    void chrome.runtime.openOptionsPage();
    return;
  }
  if (typeof info.menuItemId !== 'string') return;
  if (!info.menuItemId.startsWith(MENU_ACTION_PREFIX)) return;

  const actionId = info.menuItemId.slice(MENU_ACTION_PREFIX.length);
  void invokeInTab(tab, actionId);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'run-default-action') return;
  void (async () => {
    const settings = await loadSettings();
    await invokeInTab(tab, settings.defaultActionId);
  })();
});

chrome.action.onClicked.addListener((tab) => {
  void (async () => {
    if (!(await ensureContentScript(tab))) {
      await chrome.runtime.openOptionsPage();
      return;
    }
    await sendToTab(tab!.id!, { type: 'proofkey:toggle-live' });
  })();
});

/**
 * Hands the action to the content script rather than reading the selection
 * here: `info.selectionText` collapses newlines and is empty when the caret is
 * simply inside a field, and only the page can write text back safely.
 */
async function invokeInTab(tab: chrome.tabs.Tab | undefined, actionId: string): Promise<void> {
  if (!(await ensureContentScript(tab))) {
    await flashBadge('!', '#c2410c');
    return;
  }
  await sendToTab(tab!.id!, { type: 'proofkey:invoke', actionId });
}

// -------------------------------------------------------------- injection

async function ensureContentScript(tab: chrome.tabs.Tab | undefined): Promise<boolean> {
  if (!tab?.id || !isInjectableUrl(tab.url)) return false;

  // Already there? Cheaper than injecting twice and losing in-page state.
  try {
    const pong = await chrome.tabs.sendMessage(tab.id, {
      type: 'proofkey:ping',
    } satisfies WorkerRequest);
    if (pong) return true;
  } catch {
    // No receiver yet — expected on the first invocation for a tab.
  }

  try {
    await injectFiles(tab.id, [CONTENT_SCRIPT]);
    return true;
  } catch (error) {
    console.warn('[ProofKey] injection failed', error);
    return false;
  }
}

async function sendToTab(tabId: number, message: WorkerRequest): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    console.warn('[ProofKey] could not reach the content script', error);
  }
}

// ---------------------------------------------------------- message router

chrome.runtime.onMessage.addListener((message: ContentRequest, sender, sendResponse) => {
  handle(message, sender)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies Result<never>);
    });
  return true; // keep the channel open for the async reply
});

async function handle(
  message: ContentRequest,
  sender: chrome.runtime.MessageSender,
): Promise<Result<unknown>> {
  switch (message.type) {
    case 'proofkey:open-options':
      await chrome.runtime.openOptionsPage();
      return { ok: true, value: null };

    case 'proofkey:get-state':
      return { ok: true, value: await buildContentState(sender) };

    case 'proofkey:run':
      return runAction(message.actionId, message.text);

    case 'proofkey:explain':
      return explain(message.original, message.replacement);
  }
}

async function runAction(actionId: string, text: string): Promise<Result<RunResult>> {
  if (!text.trim()) return { ok: false, error: 'Nothing to work on.' };

  const settings = await loadSettings();
  const action = findAction(settings, actionId);
  if (!action) return { ok: false, error: `Unknown action "${actionId}".` };

  try {
    const result = await runCompletion(connectionChain(settings), {
      systemPrompt: composeSystemPrompt(action, settings.profile),
      userText: text,
    });
    return {
      ok: true,
      value: {
        text: result.text.trim(),
        servedBy: result.connection.label,
        fallbackErrors: result.fallbackErrors,
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function explain(original: string, replacement: string): Promise<Result<RunResult>> {
  const settings = await loadSettings();
  try {
    const result = await runCompletion(connectionChain(settings), {
      systemPrompt: composeExplainPrompt(settings.profile),
      userText: `Written: ${original}\nSuggested: ${replacement}`,
    });
    return {
      ok: true,
      value: { text: result.text.trim(), servedBy: result.connection.label, fallbackErrors: [] },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function buildContentState(sender: chrome.runtime.MessageSender): Promise<ContentState> {
  const settings = await loadSettings();
  const origin = originOf(sender.url ?? sender.tab?.url);

  return {
    actions: resolveActions(settings)
      .filter((action) => action.enabled)
      .map((action) => ({ id: action.id, label: action.label })),
    defaultActionId: settings.defaultActionId,
    liveEnabled:
      !!origin &&
      settings.liveCheck.enabledOrigins.includes(origin) &&
      !settings.liveCheck.blockedOrigins.includes(origin),
    debounceMs: settings.liveCheck.debounceMs,
    minChars: settings.liveCheck.minChars,
    maxSentencesPerRequest: settings.liveCheck.maxSentencesPerRequest,
    dictionary: settings.liveCheck.dictionary,
    configured: connectionChain(settings).some((c) => validateConnection(c) === null),
  };
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The only feedback channel available when no content script could be injected. */
async function flashBadge(text: string, color: string): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  setTimeout(() => void chrome.action.setBadgeText({ text: '' }), 4000);
}
