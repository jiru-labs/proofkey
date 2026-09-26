/**
 * Checks how ProofKey finds a model server on this computer:
 *
 *     node --experimental-strip-types tools/local-servers-check.ts
 *
 * Each case is a real server on a loopback port, not a stubbed promise, because
 * the distinctions that matter live in the network stack: a closed port rejects,
 * a server that never answers times out, and a default Ollama answers 403 to an
 * extension origin it was not told to allow — which must read as "running, and
 * refusing", not as "no Ollama".
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  describeProbe,
  findLocalServers,
  localServerOrigins,
  LOCAL_SERVERS,
  probeLocalServer,
  type LocalServer,
} from '../src/core/localServers.ts';
import { getPreset } from '../src/core/presets.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

type Handler = Parameters<typeof createServer>[1];
async function serve(handler: Handler): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}
const at = (port: number, presetId: LocalServer['presetId'] = 'lmstudio', label = 'Test server'): LocalServer => ({
  presetId,
  label,
  baseUrl: `http://127.0.0.1:${port}/v1`,
});

console.log('probing:');

{
  const { server, port } = await serve((req, res) => {
    check('asks for the model list', req.url === '/v1/models', req.url);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'qwen3-4b-instruct-2507' }, { id: 'gemma-3-4b' }, { id: 7 }] }));
  });
  const probe = await probeLocalServer(at(port));
  check('a running server with models is found', probe.status === 'found');
  check(
    'only string ids are kept',
    probe.status === 'found' && probe.models.join(',') === 'qwen3-4b-instruct-2507,gemma-3-4b',
    probe.status === 'found' ? probe.models.join(',') : probe.status,
  );
  check('and described with its count', describeProbe(probe) === 'Test server: running, with 2 models.', describeProbe(probe) ?? '');
  server.close();
}

{
  const { server, port } = await serve((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [] }));
  });
  const probe = await probeLocalServer(at(port));
  check('a server with nothing loaded is found, with no models', probe.status === 'found' && probe.models.length === 0);
  check('and told to load one', /no model is loaded/.test(describeProbe(probe) ?? ''), describeProbe(probe) ?? '');
  server.close();
}

{
  const { server, port } = await serve((_req, res) => {
    res.statusCode = 403;
    res.end();
  });
  const probe = await probeLocalServer(at(port, 'ollama', 'Ollama (local)'));
  check('Ollama answering 403 is running, not absent', probe.status === 'refused' && probe.httpStatus === 403);
  check(
    'and the fix is named',
    describeProbe(probe)?.includes('OLLAMA_ORIGINS="chrome-extension://*"') ?? false,
    describeProbe(probe) ?? '',
  );
  server.close();
}

{
  const { server, port } = await serve((_req, res) => {
    res.statusCode = 500;
    res.end();
  });
  const probe = await probeLocalServer(at(port));
  check('another error status is reported as is', describeProbe(probe) === 'Test server: running, but it answered HTTP 500.', describeProbe(probe) ?? '');
  server.close();
}

{
  const { server, port } = await serve(() => undefined);
  const started = Date.now();
  const probe = await probeLocalServer(at(port), fetch, 300);
  const took = Date.now() - started;
  check('a server that never answers counts as absent', probe.status === 'absent');
  check('and costs no more than the timeout', took < 1500, `${took} ms`);
  check('absent is not described', describeProbe(probe) === null);
  server.closeAllConnections();
  server.close();
}

{
  const { server, port } = await serve(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const probe = await probeLocalServer(at(port));
  check('a closed port counts as absent', probe.status === 'absent');
}

console.log('\nthe defaults:');

check(
  'LM Studio, Ollama and llama.cpp, on their own default ports',
  LOCAL_SERVERS.map((s) => new URL(s.baseUrl).port).join(',') === '1234,11434,8080',
  LOCAL_SERVERS.map((s) => s.baseUrl).join(' '),
);
check(
  'LM Studio and Ollama match their presets, label and address',
  LOCAL_SERVERS.filter((s) => s.presetId !== 'vllm').every(
    (s) => getPreset(s.presetId).label === s.label && getPreset(s.presetId).baseUrl === s.baseUrl,
  ),
);
check(
  'every default is a loopback address',
  LOCAL_SERVERS.every((s) => ['127.0.0.1', 'localhost'].includes(new URL(s.baseUrl).hostname)),
);
check(
  'the permission asked for is exactly those origins',
  localServerOrigins().join(' ') === 'http://127.0.0.1:1234/* http://localhost:11434/* http://127.0.0.1:8080/*',
  localServerOrigins().join(' '),
);

{
  const seen: string[] = [];
  const stub = (async (url: string) => {
    seen.push(url);
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;
  const probes = await findLocalServers(stub);
  check('one request per server, to its model list, and no other', seen.length === 3 && seen.every((u) => u.endsWith('/v1/models')), seen.join(' '));
  check('nothing running means nothing found', probes.every((p) => p.status === 'absent'));
}

if (failures > 0) {
  console.error(`\n${failures} local-server check(s) failed.`);
  process.exit(1);
}
console.log('\nLocal-server checks passed.');
