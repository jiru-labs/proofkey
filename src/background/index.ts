import {
  hasDynamicContentScripts,
  hasScriptingApi,
  injectFiles,
  isInjectableUrl,
  originMatchPattern,
} from '../core/browser';
import type {
  CheckResult,
  ContentRequest,
  ContentState,
  FrameGrant,
  FrameOffer,
  Result,
  RunResult,
  WorkerRequest,
} from '../core/messages';
import {
  composeCheckPrompt,
  composeExplainPrompt,
  composeSystemPrompt,
  formatCheckPayload,
  parseCheckReply,
  resolveTargetLanguage,
  TARGET_LANGUAGE,
} from '../core/prompts';
import { runCompletion, validateConnection } from '../core/providers';
import {
  connectionChain,
  findAction,
  loadSettings,
  resolveActions,
  saveSettings,
  shortcutBindings,
} from '../core/storage';

const MENU_ROOT = 'proofkey:root';
const MENU_ACTION_PREFIX = 'proofkey:action:';
const MENU_SETTINGS = 'proofkey:settings';
const CONTENT_SCRIPT = 'content.js';
const SHORTCUT_SCRIPT_ID = 'proofkey-shortcuts';

// ---------------------------------------------------------------- lifecycle

chrome.runtime.onInstalled.addListener((details) => {
  void rebuildContextMenus();
  void syncShortcutOrigins();
  // Nothing works until a provider exists, so send first-time users straight there.
  if (details.reason === 'install') void chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => {
  void syncShortcutOrigins();
});

// Menu labels come from the user's actions, so they have to follow edits.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== 'sync') return;
  void rebuildContextMenus();
  void syncShortcutOrigins();
});

// Host access can be revoked from chrome://extensions without ProofKey being
// asked. Re-syncing here keeps the registration from outliving the permission.
chrome.permissions.onRemoved.addListener(() => void syncShortcutOrigins());
chrome.permissions.onAdded.addListener(() => void syncShortcutOrigins());

async function rebuildContextMenus(): Promise<void> {
  await chrome.contextMenus.removeAll();
  const settings = await loadSettings();

  chrome.contextMenus.create({
    id: MENU_ROOT,
    title: 'ProofKey',
    contexts: ['selection', 'editable'],
  });

  // An action carrying the target-language token is shown with the language it
  // would actually use — "Translate to Portuguese" rather than "Translate".
  // The menu is rebuilt on every settings change already, so this follows the
  // profile without any extra wiring.
  const targetLanguage = resolveTargetLanguage(settings.profile);

  for (const action of resolveActions(settings)) {
    if (!action.enabled) continue;
    const named =
      targetLanguage && action.systemPrompt.includes(TARGET_LANGUAGE)
        ? `${action.label} to ${targetLanguage}`
        : action.label;
    chrome.contextMenus.create({
      id: `${MENU_ACTION_PREFIX}${action.id}`,
      parentId: MENU_ROOT,
      title: named,
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

// ------------------------------------------------------- shortcut origins

/**
 * Registers the content script on the origins the user turned shortcuts on for.
 *
 * A key pressed on a page ProofKey is not in cannot reach it, and ProofKey is
 * not in any page by default — that is the whole point of shipping no static
 * `content_scripts` block. So per-action shortcuts need this, and only this:
 * the registration covers exactly the opted-in origins, and only those the
 * browser confirms access to, so a revoked permission takes the registration
 * with it rather than leaving a listener the user thinks they removed.
 */
async function syncShortcutOrigins(): Promise<void> {
  if (!hasDynamicContentScripts()) return;

  try {
    const settings = await loadSettings();
    const wanted = [...new Set(settings.shortcutOrigins.map(originMatchPattern).filter(isPattern))];

    const granted: string[] = [];
    for (const pattern of wanted) {
      if (await chrome.permissions.contains({ origins: [pattern] })) granted.push(pattern);
    }

    const registered = await chrome.scripting.getRegisteredContentScripts();
    const existing = registered.find((script) => script.id === SHORTCUT_SCRIPT_ID);

    if (granted.length === 0) {
      if (existing) await chrome.scripting.unregisterContentScripts({ ids: [SHORTCUT_SCRIPT_ID] });
      return;
    }

    const script: chrome.scripting.RegisteredContentScript = {
      id: SHORTCUT_SCRIPT_ID,
      matches: granted,
      js: [CONTENT_SCRIPT],
      runAt: 'document_idle',
      // Whole applications are built inside a frame -- iCloud Mail and Infomaniak
      // Mail both are -- and Chrome defaults this to false, so the script reached
      // the top frame only and those sites got no underlines, no badge and no
      // error. This does not widen exposure: every frame is still matched against
      // `granted` on its own url, so a frame whose origin the user never granted
      // is still skipped.
      //
      // Necessary but not sufficient. A granted page does not grant the frames
      // inside it, so an editor in a cross-origin frame needs that frame's
      // origin in `granted` too. Measured both ways on the published 0.1.4 build
      // 2026-09-04: iCloud (editor two frames down on
      // `www-mail.icloud-sandbox.com`) and Infomaniak (whole app on
      // `mail.infomaniak.com`) each do nothing with only the address-bar origin
      // granted, and both underline and apply correctly once the frame origin is
      // added by hand. The toolbar toggle knows only the tab's origin, so the
      // offer is made from inside the page instead -- `frameGrant` below, at the
      // moment focus lands in a frame this registration does not reach.
      // See COMPATIBILITY.md, "Editors in iframes".
      allFrames: true,
    };

    if (existing) await chrome.scripting.updateContentScripts([script]);
    else await chrome.scripting.registerContentScripts([script]);
  } catch (error) {
    console.warn('[ProofKey] could not sync shortcut origins', error);
  }
}

function isPattern(value: string | null): value is string {
  return value !== null;
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

    case 'proofkey:check':
      return check(message.sentences);

    case 'proofkey:explain':
      return explain(message.original, message.replacement);

    case 'proofkey:set-live':
      return setLive(sender, message.enabled);

    case 'proofkey:add-word':
      return addWord(message.word);

    case 'proofkey:frame-offer':
      return frameOffer(sender, message.origin);

    case 'proofkey:frame-grant':
      return frameGrant(sender, message.origin);
  }
}

// ---------------------------------------------------------- frame origins

/**
 * Whether a frame on `origin`, inside the page that asked, still needs setting
 * up before ProofKey can work in it.
 *
 * Three things have to hold for a frame on another origin, and a grant alone
 * is none of them: the browser has to allow the origin, the script has to be
 * registered there so it loads with the frame, and if live checking is on for
 * the page it has to be on for the frame as well — the frame reports its own
 * origin, not the page's. An origin the user put on the never-run list is
 * left alone; that list is a decision, not an oversight.
 */
async function frameOffer(
  sender: chrome.runtime.MessageSender,
  origin: string,
): Promise<Result<FrameOffer>> {
  const pattern = originMatchPattern(origin);
  const parent = originOf(sender.url ?? sender.tab?.url);
  if (!pattern || !parent || origin === parent) return { ok: true, value: { needed: false } };

  const settings = await loadSettings();
  const { enabledOrigins, blockedOrigins } = settings.liveCheck;
  if (blockedOrigins.includes(origin)) return { ok: true, value: { needed: false } };

  const granted = await chrome.permissions.contains({ origins: [pattern] });
  const registered = settings.shortcutOrigins.includes(origin);
  const parentLive = enabledOrigins.includes(parent) && !blockedOrigins.includes(parent);
  const frameLive = enabledOrigins.includes(origin);

  return { ok: true, value: { needed: !granted || !registered || (parentLive && !frameLive) } };
}

/**
 * Allows a frame origin from inside the page around it.
 *
 * The permission request is the first thing that happens, before anything is
 * awaited. The browser only shows its prompt from a user gesture, and the
 * gesture here is the click on Allow in the page, carried over by the message
 * that got this far — it does not survive being made to wait.
 *
 * Once granted, the origin is registered the same way a hand-typed one is:
 * added to the shortcut origins, which `syncShortcutOrigins` turns into a
 * registration on the next settings change, and switched on for live checking
 * if the page around it is. It is also remembered as belonging to this page,
 * so the toolbar toggle on the page carries it. Then the script is injected
 * into whichever frames of the tab do not have it yet, so the editor works
 * now rather than after a reload.
 */
async function frameGrant(
  sender: chrome.runtime.MessageSender,
  origin: string,
): Promise<Result<FrameGrant>> {
  const pattern = originMatchPattern(origin);
  const parent = originOf(sender.url ?? sender.tab?.url);
  if (!pattern || !parent) {
    return { ok: false, error: `"${origin}" is not an address ProofKey can be allowed on.` };
  }

  let granted: boolean;
  try {
    granted = await chrome.permissions.request({ origins: [pattern] });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `The browser would not ask about ${new URL(origin).host} (${reason}). Add it under "Shortcuts run on" in Settings and save; that click can ask.`,
    };
  }
  if (!granted) return { ok: true, value: { granted: false, injected: false } };

  const settings = await loadSettings();
  const { enabledOrigins, blockedOrigins } = settings.liveCheck;
  if (!settings.shortcutOrigins.includes(origin)) settings.shortcutOrigins.push(origin);

  const parentLive = enabledOrigins.includes(parent) && !blockedOrigins.includes(parent);
  if (parentLive && !enabledOrigins.includes(origin)) enabledOrigins.push(origin);

  const siblings = settings.frameOrigins[parent] ?? [];
  if (!siblings.includes(origin)) settings.frameOrigins[parent] = [...siblings, origin];

  await saveSettings(settings);

  const injected = await injectIntoBareFrames(sender.tab?.id);
  return { ok: true, value: { granted: true, injected } };
}

/**
 * Injects the content script into every frame of a tab that can be reached
 * and does not carry it yet.
 *
 * Injecting into all frames outright would run the script a second time in
 * the frames that already have it — a second badge, a second set of
 * listeners. Probing first costs one round trip and needs no frame list from
 * the browser: `executeScript` reports the frame it ran in, and it only runs
 * where the extension is allowed, so an origin that was never granted is
 * simply absent from the answer.
 */
async function injectIntoBareFrames(tabId: number | undefined): Promise<boolean> {
  if (tabId === undefined || !hasScriptingApi()) return false;
  try {
    const probes = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => !!document.getElementById('proofkey-root'),
    });
    const bare = probes.filter((probe) => probe.result === false).map((probe) => probe.frameId);
    if (bare.length === 0) return false;
    await chrome.scripting.executeScript({ target: { tabId, frameIds: bare }, files: [CONTENT_SCRIPT] });
    return true;
  } catch (error) {
    console.warn('[ProofKey] could not inject into frames', error);
    return false;
  }
}

async function addWord(word: string): Promise<Result<string[]>> {
  const trimmed = word.trim();
  if (!trimmed) return { ok: false, error: 'Nothing to add.' };

  const settings = await loadSettings();
  const dictionary = new Set(settings.liveCheck.dictionary);
  dictionary.add(trimmed);
  settings.liveCheck.dictionary = [...dictionary];
  await saveSettings(settings);
  return { ok: true, value: settings.liveCheck.dictionary };
}

/**
 * Checks a batch of sentences in one request. If the model breaks the numbered
 * contract the batch is retried one sentence at a time — mis-attributing a
 * correction to the wrong sentence would underline the wrong words, which is
 * worse than spending a few extra requests.
 */
async function check(sentences: string[]): Promise<Result<CheckResult>> {
  if (sentences.length === 0) return { ok: true, value: { corrections: [] } };

  const settings = await loadSettings();
  const chain = liveChain(settings);

  try {
    const result = await runCompletion(chain, {
      systemPrompt: composeCheckPrompt(settings.profile, sentences.length),
      userText: formatCheckPayload(sentences),
    });

    const parsed = parseCheckReply(result.text, sentences.length);
    if (parsed) return { ok: true, value: { corrections: parsed } };

    if (sentences.length === 1) {
      // Nothing to fall back to; treat the reply as the correction itself.
      return { ok: true, value: { corrections: [stripNumbering(result.text)] } };
    }

    const individually = await Promise.all(
      sentences.map(async (sentence) => {
        const single = await runCompletion(chain, {
          systemPrompt: composeCheckPrompt(settings.profile, 1),
          userText: formatCheckPayload([sentence]),
        });
        return parseCheckReply(single.text, 1)?.[0] ?? sentence;
      }),
    );
    return { ok: true, value: { corrections: individually } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function stripNumbering(text: string): string {
  return text.trim().replace(/^\s*\d+\s*[.)]\s?/, '');
}

/** Live checking may be pinned to a cheaper connection than the actions use. */
function liveChain(settings: Awaited<ReturnType<typeof loadSettings>>) {
  const pinned = settings.liveCheck.connectionId
    ? settings.connections.find((c) => c.id === settings.liveCheck.connectionId)
    : undefined;
  return pinned ? [pinned] : connectionChain(settings);
}

async function setLive(
  sender: chrome.runtime.MessageSender,
  enabled: boolean,
): Promise<Result<boolean>> {
  const origin = originOf(sender.url ?? sender.tab?.url);
  if (!origin) return { ok: false, error: 'This page has no origin ProofKey can remember.' };

  const settings = await loadSettings();
  const enabledOrigins = new Set(settings.liveCheck.enabledOrigins);
  // A frame origin allowed from this page follows the page. Live checking
  // spends the key, and a frame left running after the page was switched off
  // would be doing exactly what the user just asked it not to.
  for (const each of [origin, ...(settings.frameOrigins[origin] ?? [])]) {
    if (enabled) enabledOrigins.add(each);
    else enabledOrigins.delete(each);
  }

  settings.liveCheck.enabledOrigins = [...enabledOrigins];
  await saveSettings(settings);
  return { ok: true, value: enabled };
}

async function runAction(actionId: string, text: string): Promise<Result<RunResult>> {
  if (!text.trim()) return { ok: false, error: 'Nothing to work on.' };

  const settings = await loadSettings();
  const action = findAction(settings, actionId);
  if (!action) return { ok: false, error: `Unknown action "${actionId}".` };

  // Gated on the token still being there after composition rather than on the
  // action's id, so a user who edits Translate's prompt to name a language
  // outright stops being asked for one, and a custom action that uses the token
  // gets the same check for free.
  const systemPrompt = composeSystemPrompt(action, settings.profile);
  if (systemPrompt.includes(TARGET_LANGUAGE)) {
    return {
      ok: false,
      error: `"${action.label}" needs a language. Set one under Profile in the options page.`,
    };
  }

  try {
    const result = await runCompletion(connectionChain(settings), {
      systemPrompt,
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
    // Gated on the origin, not just on the registration: the content script is
    // also injected on demand by the menu and the toolbar button, and a page
    // reached that way must not start listening for keys because of it.
    shortcuts: origin && settings.shortcutOrigins.includes(origin) ? shortcutBindings(settings) : [],
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
