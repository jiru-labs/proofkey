/**
 * Checks which protocol each connection's requests use:
 *
 *     node --experimental-strip-types tools/transport-check.ts
 *
 * OpenCode Go splits its catalogue by protocol (measured 2026-10-10): `gpt-*-luna`
 * and `grok-*` answer only the Responses API, `glm-*` and `kimi-*` only
 * `/chat/completions`, and each refuses the other with `ModelProtocolUnsupported`.
 * A connection keeps one stored `transport`, so the preset decides per model —
 * and only while the connection still points at Go, so a base-URL edit does not
 * drag a custom endpoint onto a protocol it never offered.
 */

import { effectiveTransport, getPreset } from '../src/core/presets.ts';
import type { Connection, PresetId } from '../src/core/types.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function connection(presetId: PresetId, model: string, overrides: Partial<Connection> = {}): Connection {
  const preset = getPreset(presetId);
  return {
    id: 't', label: preset.label, presetId, transport: preset.transport, baseUrl: preset.baseUrl,
    apiKey: 'k', model, authStyle: preset.authStyle, extraHeaders: {}, extraBody: {}, extraQuery: {},
    maxOutputTokens: 512, thinking: 'off', ...overrides,
  } as Connection;
}

console.log('\ntransport per model');
check('Go default model is gpt-6-luna', getPreset('opencode-go').defaultModel === 'gpt-6-luna');
check('Go gpt-6-luna → Responses', effectiveTransport(connection('opencode-go', 'gpt-6-luna')) === 'openai_responses');
check('Go gpt-5.6-luna → Responses', effectiveTransport(connection('opencode-go', 'gpt-5.6-luna')) === 'openai_responses');
check('Go grok-4.7 → Responses', effectiveTransport(connection('opencode-go', 'grok-4.7')) === 'openai_responses');
check('Go glm-5.3 → chat completions', effectiveTransport(connection('opencode-go', 'glm-5.3')) === 'chat_completions');
check(
  'a Go connection saved before (transport chat_completions, model gpt-5.6-luna) now uses Responses',
  effectiveTransport(connection('opencode-go', 'gpt-5.6-luna', { transport: 'chat_completions' })) === 'openai_responses',
);
check(
  'not once its base URL points elsewhere',
  effectiveTransport(connection('opencode-go', 'gpt-6-luna', { transport: 'chat_completions', baseUrl: 'http://localhost:9999/v1' })) === 'chat_completions',
);
check('other presets keep their transport', effectiveTransport(connection('openrouter', 'gpt-5.6-luna')) === 'chat_completions');
check('Go asks for a session header', getPreset('opencode-go').sessionHeader === 'x-opencode-session');
check('no other preset does', getPreset('openrouter').sessionHeader === undefined && getPreset('anthropic').sessionHeader === undefined);

if (failures) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nTransport checks passed.');
