/**
 * Checks which endpoints get told not to think, and which must not be:
 *
 *     node --experimental-strip-types tools/thinking-check.ts
 *
 * Thinking is off by default because proofreading does not benefit from it — a
 * model that cannot disable it returns 194 completion tokens where one with it
 * disabled returns 196, at 4.2s to 48s instead of ~1s, and on xAI at 1,199 to
 * 3,428 billed reasoning tokens on top.
 *
 * What makes this worth a test rather than a constant is that `reasoning_effort`
 * is **not portable**. Gemini 2.5 flash and flash-lite honour it while 3.x and
 * 2.5-pro drop it silently; on xAI only `grok-4.3` accepts it, and every other
 * Grok answers HTTP 400 — refusing the value or the parameter — on every single
 * request. So the fragment is derived from the preset at request time and
 * guarded on the base URL still matching the one it was measured against.
 *
 * That guard is the regression to protect. Only the provider dropdown rewrites a
 * connection's `extraBody`, so anything stored there outlives a base-URL edit;
 * deriving this field instead means it stops being sent the moment the
 * connection stops pointing where the measurement was taken. The end-to-end half
 * of that — a real service worker, a real request — is asserted in
 * `tools/extension-test.mjs`.
 */

import { disableThinkingBody, getPreset, thinkingNote } from '../src/core/presets.ts';
import type { Connection, PresetId } from '../src/core/types.ts';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A connection as the options page would build it from the preset. */
function connectionFor(presetId: PresetId, model: string, overrides: Partial<Connection> = {}) {
  const preset = getPreset(presetId);
  return {
    id: 'test',
    label: preset.label,
    presetId,
    transport: preset.transport,
    baseUrl: preset.baseUrl,
    apiKey: 'k',
    model,
    authStyle: preset.authStyle,
    extraHeaders: {},
    extraBody: {},
    extraQuery: {},
    maxOutputTokens: 2048,
    thinking: 'off',
    ...overrides,
  } as Connection;
}

const effort = (connection: Connection): unknown =>
  disableThinkingBody(connection)?.['reasoning_effort'];

console.log('\nGemini — honoured on 2.5, dropped silently on 3.x, harmful nowhere:');

check('2.5-flash-lite is told not to think', effort(connectionFor('gemini', 'gemini-2.5-flash-lite')) === 'none');
check('2.5-flash likewise', effort(connectionFor('gemini', 'gemini-2.5-flash')) === 'none');
check(
  '3.1-flash-lite is sent it too, because being ignored costs nothing',
  effort(connectionFor('gemini', 'gemini-3.1-flash-lite')) === 'none',
);

console.log('\nxAI — one model accepts it and the rest answer 400:');

check('grok-4.3 accepts it, so it is sent', effort(connectionFor('xai', 'grok-4.3')) === 'none');
check(
  'grok-4.5 refuses the value, so nothing is sent',
  effort(connectionFor('xai', 'grok-4.5')) === undefined,
);
check(
  "the preset's own default refuses the parameter, so nothing is sent",
  effort(connectionFor('xai', 'grok-4.20-0309-non-reasoning')) === undefined,
);
check(
  'grok-build-0.1 refuses it too',
  effort(connectionFor('xai', 'grok-build-0.1')) === undefined,
);

console.log('\nThe guard — a switch measured on one endpoint is not sent to another:');

check(
  'a Gemini connection repointed at xAI stops sending it',
  effort(connectionFor('gemini', 'gemini-2.5-flash-lite', { baseUrl: 'https://api.x.ai/v1' })) ===
    undefined,
);
check(
  'a trailing slash is not a different endpoint',
  effort(
    connectionFor('gemini', 'gemini-2.5-flash-lite', {
      baseUrl: `${getPreset('gemini').baseUrl}/`,
    }),
  ) === 'none',
);
check(
  'a provider with no measured switch is sent nothing',
  effort(connectionFor('openai', 'gpt-4.1-mini')) === undefined,
);
check(
  'Custom is sent nothing — it has no endpoint to have measured',
  effort(connectionFor('custom', 'whatever', { baseUrl: 'http://127.0.0.1:8080/v1' })) === undefined,
);

console.log('\nLeaving it on:');

check(
  "'default' sends nothing even where the switch exists",
  effort(connectionFor('gemini', 'gemini-2.5-flash-lite', { thinking: 'default' })) === undefined,
);

console.log('\nThe options page explains which of those happened:');

const says = (connection: Connection, fragment: string) =>
  thinkingNote(connection).includes(fragment);

check('the working case names what is sent', says(connectionFor('gemini', 'gemini-2.5-flash-lite'), 'reasoning_effort'));
check(
  'a rejecting model is named, not silently ignored',
  says(connectionFor('xai', 'grok-4.5'), 'grok-4.5'),
);
check(
  'a repointed base URL explains why nothing is sent',
  says(connectionFor('gemini', 'x', { baseUrl: 'https://api.x.ai/v1' }), 'no longer matches'),
);
check(
  'an unmeasured provider says so rather than implying it works',
  says(connectionFor('openai', 'gpt-4.1-mini'), 'No measured way'),
);
check(
  "leaving it on says what it costs",
  says(connectionFor('gemini', 'gemini-2.5-flash-lite', { thinking: 'default' }), 'no accuracy'),
);

console.log(failures ? `\n${failures} check(s) failed.\n` : '\nThinking checks passed.\n');
process.exit(failures ? 1 : 0);
