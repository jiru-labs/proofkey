/**
 * Checks how a failed request is turned into the sentence the user reads:
 *
 *     node --experimental-strip-types tools/errors-check.ts
 *
 * `extractErrorMessage` is the seam between a provider's rejection and the
 * error text in the toast or the options page. When it misses, the user is told
 * `429 request failed` and has to guess which of rate limit, daily quota, dead
 * key or wrong model id they are looking at.
 *
 * It missed for two years' worth of Google traffic. Gemini's OpenAI-compatible
 * endpoint wraps the error in a JSON **array** where every other provider sends
 * the object bare, and an array passes `typeof === 'object'`, so every lookup
 * fell through to the status-code fallback. Confirmed against the live endpoint
 * on 2026-08-18; the array case below is that bug, pinned.
 *
 * Chrome makes the fallback worse than it looks: `response.statusText` is always
 * empty over HTTP/2, which every hosted provider speaks, so the fallback that
 * reads `400 Bad Request` under Node reads `400 request failed` in the
 * extension. That is the string a user actually reports.
 */

import { postJson, ProviderError } from '../src/core/providers/request.ts';
import type { Connection } from '../src/core/types.ts';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const connection = { label: 'Test connection' } as Connection;

/** Sends `body` back as the response to the next request, then reads the error. */
async function messageFor(
  body: string,
  init: ResponseInit,
): Promise<{ message: string; status: number | undefined }> {
  globalThis.fetch = (async () => new Response(body, init)) as typeof fetch;
  try {
    await postJson(connection, 'https://example.test/v1/chat/completions', {}, {});
    return { message: '(no error thrown)', status: undefined };
  } catch (error) {
    const err = error as ProviderError;
    return { message: err.message, status: err.status };
  }
}

async function equal(name: string, body: string, init: ResponseInit, expected: string) {
  const { message } = await messageFor(body, init);
  check(name, message === expected, message === expected ? '' : `got "${message}"`);
}

const rateLimited = { status: 429 } satisfies ResponseInit;

console.log('\nextractErrorMessage — the shapes providers actually send:');

await equal(
  'Gemini wraps the error object in an array',
  '[{"error": {"code": 429, "message": "Quota exceeded for quota metric X"}}]',
  rateLimited,
  'Quota exceeded for quota metric X',
);
await equal(
  'a bare error object is read the same way',
  '{"error": {"code": 429, "message": "Rate limit reached"}}',
  rateLimited,
  'Rate limit reached',
);
await equal(
  'an error given as a plain string',
  '{"error": "Rate limit reached"}',
  rateLimited,
  'Rate limit reached',
);
await equal(
  'a top-level message field',
  '{"message": "Too many requests"}',
  rateLimited,
  'Too many requests',
);
await equal(
  'Ollama and llama.cpp report on `detail`',
  '{"detail": "model is loading"}',
  { status: 503 },
  'model is loading',
);
await equal(
  'a body that is not JSON at all is passed through',
  'upstream connect error',
  { status: 502 },
  'upstream connect error',
);

console.log('\nWhat the user sees when the provider explains nothing:');

await equal(
  'an empty body over HTTP/2, where statusText is blank',
  '',
  { status: 429, statusText: '' },
  '429 request failed',
);
await equal(
  'an empty array is not mistaken for a message',
  '[]',
  { status: 429, statusText: '' },
  '429 request failed',
);
await equal(
  'statusText is used when the transport supplies one',
  '',
  { status: 429, statusText: 'Too Many Requests' },
  '429 Too Many Requests',
);

console.log('\nThe status code reaches the error object:');

const { status } = await messageFor('[{"error": {"message": "nope"}}]', rateLimited);
check('a 429 arrives as 429', status === 429, status === 429 ? '' : `got ${String(status)}`);

console.log(failures ? `\n${failures} check(s) failed.\n` : '\nError checks passed.\n');
process.exit(failures ? 1 : 0);
