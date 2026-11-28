/**
 * Unit checks for core modules not covered by dedicated scripts:
 * sentences, browser helpers, storage merging/chains, URL/header/abort handling,
 * provider validation, and response edge cases.
 *
 *     node --experimental-strip-types tools/core-check.ts
 */

import { isInjectableUrl, normalizeOrigin, originMatchPattern } from '../src/core/browser.ts';
import { getPreset, liveModel, replacementModel } from '../src/core/presets.ts';
import { complete as anthropicComplete } from '../src/core/providers/anthropic.ts';
import { complete as chatComplete } from '../src/core/providers/chatCompletions.ts';
import { originPattern, runCompletion, validateConnection } from '../src/core/providers/index.ts';
import { buildHeaders, buildUrl, getJson, postJson, ProviderError } from '../src/core/providers/request.ts';
import { complete as responsesComplete } from '../src/core/providers/responses.ts';
import { sessionHeaders } from '../src/core/providers/session.ts';
import { segment, sentenceAt, sentenceKey } from '../src/core/sentences.ts';
import {
  connectionChain,
  connectionFromPreset,
  defaultSettings,
  mergeOnSave,
  normalizeSettings,
  shortcutBindings,
  shortcutConflicts,
} from '../src/core/storage.ts';
import type { Connection, PresetId } from '../src/core/types.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function makeConn(overrides: Partial<Connection> = {}): Connection {
  return {
    ...connectionFromPreset('openai'),
    apiKey: 'sk-test-123456',
    ...overrides,
  };
}

console.log('\nsentences:');
{
  const s = segment('First sentence. Second sentence.');
  check('segments two sentences', s.length === 2, String(s.length));
  // Caret right at the boundary between sentence 0 and sentence 1 belongs to sentence 1.
  check(
    'sentenceAt boundary selects the sentence starting at caret, not the finished one',
    sentenceAt(s, s[1]!.start) === 1,
    `got ${sentenceAt(s, s[1]!.start)} (s0=[${s[0]!.start},${s[0]!.end}], s1=[${s[1]!.start},${s[1]!.end}])`,
  );
  check('sentenceAt end of text selects the last sentence', sentenceAt(s, s[1]!.end) === 1);
  check('sentenceKey ignores trailing whitespace', sentenceKey('Hello.  ') === sentenceKey('Hello.'));
}

console.log('\nbrowser:');
{
  check('normalizeOrigin accepts IPv6 loopback', normalizeOrigin('http://[::1]:8000') === 'http://[::1]:8000', String(normalizeOrigin('http://[::1]:8000')));
  check('normalizeOrigin rejects mailto:', normalizeOrigin('mailto:a@b.com') === null, String(normalizeOrigin('mailto:a@b.com')));
  check('isInjectableUrl rejects Chrome Web Store (legacy)', !isInjectableUrl('https://chrome.google.com/webstore/detail/abc'));
  check('isInjectableUrl rejects Edge Add-ons', !isInjectableUrl('https://microsoftedge.microsoft.com/addons/detail/abc'));
  check('isInjectableUrl rejects chrome://', !isInjectableUrl('chrome://settings'));
  check('isInjectableUrl allows https://', isInjectableUrl('https://mail.google.com'));
  check('originMatchPattern rejects file://', originMatchPattern('file:///tmp/a.html') === null);
}

console.log('\nstorage & presets:');
{
  check('getPreset falls back to custom, not chrome-builtin', getPreset('unknown-preset' as PresetId).id === 'custom', getPreset('unknown-preset' as PresetId).id);

  const repointedGemini = makeConn({ presetId: 'gemini', baseUrl: 'https://my-proxy.test/v1', model: 'gemini-2.5-flash' });
  check(
    'liveModel respects baseUrl guard for repointed connections',
    liveModel(repointedGemini, '2026-12-15') === 'gemini-2.5-flash',
    liveModel(repointedGemini, '2026-12-15'),
  );
  const openaiOld = makeConn({ presetId: 'openai', model: 'old-model' });
  check(
    'replacementModel returns null when defaultModel is not in available list',
    replacementModel(openaiOld, ['some-other-model']) === null,
    String(replacementModel(openaiOld, ['some-other-model'])),
  );
  check(
    'replacementModel returns defaultModel when stored model is missing and defaultModel is listed',
    replacementModel(openaiOld, [getPreset('openai').defaultModel]) === getPreset('openai').defaultModel,
    String(replacementModel(openaiOld, [getPreset('openai').defaultModel])),
  );

  const opencodeGo = makeConn({ presetId: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1' });
  const goHeaders = await sessionHeaders(opencodeGo);
  check(
    'sessionHeaders returns x-opencode-session for opencode-go preset',
    typeof goHeaders['x-opencode-session'] === 'string' && goHeaders['x-opencode-session'].length > 0,
    JSON.stringify(goHeaders),
  );

  const normalizedEmpty = normalizeSettings({ connections: [], activeConnectionId: 'stale-id' }, {});
  check(
    'normalizeSettings resets activeConnectionId when connections is empty',
    normalizedEmpty.activeConnectionId === normalizedEmpty.connections[0]!.id,
    normalizedEmpty.activeConnectionId,
  );

  const c1 = makeConn({ id: 'c1' });
  const c2 = makeConn({ id: 'c2' });
  const dedupChain = connectionChain({ ...defaultSettings(), connections: [c1, c2], activeConnectionId: 'c1', fallbackConnectionIds: ['c2', 'c2'] });
  check('connectionChain deduplicates fallbackConnectionIds', dedupChain.length === 2, String(dedupChain.length));

  // mergeOnSave must preserve worker-written autoCorrect and moved model when untouched on options page.
  const base = defaultSettings();
  base.connections = [makeConn({ id: 'c1', model: 'old-model' })];
  base.activeConnectionId = 'c1';
  const loaded = structuredClone(base);
  const edited = structuredClone(base);
  const stored = structuredClone(base);
  stored.liveCheck.autoCorrect = true;
  stored.connections[0]!.model = 'new-model';
  stored.liveCheck.enabledOrigins = ['https://a.test', 'https://b.test'];
  loaded.liveCheck.enabledOrigins = ['https://a.test'];
  edited.liveCheck.enabledOrigins = []; // user removed a.test
  mergeOnSave(edited, loaded, stored);
  check('mergeOnSave keeps removals while preserving concurrent additions', JSON.stringify(edited.liveCheck.enabledOrigins) === '["https://b.test"]', JSON.stringify(edited.liveCheck.enabledOrigins));
  check('mergeOnSave preserves worker-enabled autoCorrect when untouched', edited.liveCheck.autoCorrect === true, String(edited.liveCheck.autoCorrect));
  check('mergeOnSave preserves worker-moved model when untouched', edited.connections[0]!.model === 'new-model', edited.connections[0]!.model);

  const withShortcuts = defaultSettings();
  withShortcuts.connections = [makeConn({ id: 'c1' })];
  withShortcuts.activeConnectionId = 'c1';
  withShortcuts.builtInOverrides = {
    'fix-grammar': { shortcut: 'Alt+Shift+KeyG' },
    'improve-writing': { shortcut: 'Alt+Shift+KeyG' },
  };
  check('shortcutConflicts detects duplicate chords', shortcutConflicts(withShortcuts).get('Alt+Shift+KeyG')?.length === 2);
  check('shortcutBindings deduplicates conflicting chords', shortcutBindings(withShortcuts).length === 1);
}

console.log('\nproviders — URL, headers, validation, abort:');
{
  check('validateConnection rejects file:// URL', validateConnection(makeConn({ baseUrl: 'file:///etc/passwd' })) !== null);
  check('validateConnection rejects chrome-extension:// URL', validateConnection(makeConn({ baseUrl: 'chrome-extension://abc/v1' })) !== null);
  check('originPattern rejects file:// URL', originPattern(makeConn({ baseUrl: 'file:///tmp/x' })) === null);

  const qUrl = buildUrl(
    makeConn({ baseUrl: '  https://api.example.test/v1?api-version=2024  ', authStyle: 'query', authQueryParam: 'key', apiKey: '  abc  ' }),
    '/chat/completions',
  );
  check(
    'buildUrl trims baseUrl, preserves query string, appends path to pathname, trims query apiKey',
    qUrl === 'https://api.example.test/v1/chat/completions?api-version=2024&key=abc',
    qUrl,
  );

  const emptyKeyUrl = buildUrl(
    makeConn({ baseUrl: 'https://api.example.test/v1', authStyle: 'query', authQueryParam: 'key', apiKey: '   ' }),
    '/models',
  );
  check('buildUrl omits empty query apiKey', emptyKeyUrl === 'https://api.example.test/v1/models', emptyKeyUrl);

  const mergedHeaders = buildHeaders(
    makeConn({ apiKey: 'sk-1', extraHeaders: { Authorization: 'Bearer custom' } }),
    {},
  );
  const authKeys = Object.keys(mergedHeaders).filter((k) => k.toLowerCase() === 'authorization');
  check('buildHeaders overrides case-insensitively instead of duplicating Authorization', authKeys.length === 1 && mergedHeaders[authKeys[0]!] === 'Bearer custom', JSON.stringify(mergedHeaders));

  let seenGetContentType: string | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const h = init?.headers as Record<string, string>;
    seenGetContentType = Object.entries(h).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;
  await getJson(makeConn(), 'https://api.example.test/v1/models', buildHeaders(makeConn(), {}));
  check('getJson does not send Content-Type header', seenGetContentType === undefined, String(seenGetContentType));

  // Caller abort must NOT be swallowed into ProviderError or trigger fallback providers.
  let fetchCalls = 0;
  const controller = new AbortController();
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    fetchCalls++;
    if (init?.signal?.aborted) {
      throw init.signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new DOMException('Aborted', 'AbortError')));
      controller.abort();
    });
  }) as typeof fetch;
  let abortedCleanly = false;
  try {
    await runCompletion([makeConn({ id: 'p1', label: 'Primary' }), makeConn({ id: 'p2', label: 'Backup' })], {
      systemPrompt: 's',
      userText: 'u',
      signal: controller.signal,
    });
  } catch (err) {
    abortedCleanly = !(err instanceof ProviderError) && err instanceof DOMException && err.name === 'AbortError';
  }
  check('caller abort rethrows AbortError without hitting fallback', abortedCleanly && fetchCalls === 1, `aborted=${abortedCleanly}, calls=${fetchCalls}`);

  // extraBody cannot force stream: true.
  let sentBody: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  }) as typeof fetch;
  await chatComplete(makeConn({ extraBody: { stream: true } }), { systemPrompt: 's', userText: 'u' });
  check('chatCompletions forces stream: false even if extraBody has stream: true', sentBody['stream'] === false, String(sentBody['stream']));

  // Non-JSON 200 response reports clear non-JSON error instead of "empty response".
  globalThis.fetch = (async () => new Response('<html>login</html>', { status: 200 })) as typeof fetch;
  let nonJsonMsg = '';
  try {
    await chatComplete(makeConn(), { systemPrompt: 's', userText: 'u' });
  } catch (err) {
    nonJsonMsg = err instanceof Error ? err.message : String(err);
  }
  check('non-JSON 200 response mentions JSON instead of empty', /json/i.test(nonJsonMsg), nonJsonMsg);

  // Refusals in chatCompletions and responses are surfaced.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: '', refusal: 'Policy refusal' }, finish_reason: 'stop' }] }), { status: 200 })) as typeof fetch;
  let refusalMsg = '';
  try {
    await chatComplete(makeConn(), { systemPrompt: 's', userText: 'u' });
  } catch (err) {
    refusalMsg = err instanceof Error ? err.message : String(err);
  }
  check('chatCompletions surfaces message.refusal', /Policy refusal/.test(refusalMsg), refusalMsg);

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ status: 'failed', error: { message: 'Upstream failure' }, output: [] }), { status: 200 })) as typeof fetch;
  let respFailedMsg = '';
  try {
    await responsesComplete(makeConn({ transport: 'openai_responses' }), { systemPrompt: 's', userText: 'u' });
  } catch (err) {
    respFailedMsg = err instanceof Error ? err.message : String(err);
  }
  check('responses surfaces status=failed error message', /Upstream failure/.test(respFailedMsg), respFailedMsg);

  // Anthropic refusal & max_tokens check.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ stop_reason: 'refusal', content: [] }), { status: 200 })) as typeof fetch;
  let anthRefusal = '';
  try {
    await anthropicComplete(makeConn({ transport: 'anthropic_messages' }), { systemPrompt: 's', userText: 'u' });
  } catch (err) {
    anthRefusal = err instanceof Error ? err.message : String(err);
  }
  check('anthropic surfaces refusal', /declined/i.test(anthRefusal), anthRefusal);

  // postJson readBody failure is wrapped cleanly in ProviderError (not raw error) unless caller aborted.
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => {
      throw new DOMException('Timed out', 'TimeoutError');
    },
  })) as unknown as typeof fetch;
  let readTimeoutOk = false;
  try {
    await postJson(makeConn(), 'https://api.example.test/v1/chat/completions', {}, {});
  } catch (err) {
    readTimeoutOk = err instanceof ProviderError && /timed out/i.test(err.message);
  }
  check('postJson wraps readBody TimeoutError in ProviderError', readTimeoutOk);
}

console.log(failures === 0 ? '\nCore checks passed.' : `\n${failures} core check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
