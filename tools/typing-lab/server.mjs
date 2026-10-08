import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const port = Number(process.argv[2] || 8777);
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'POST' && u.pathname === '/log') {
    let b = ''; req.on('data', c => b += c); req.on('end', () => { fs.appendFileSync(path.join(dir, 'log.jsonl'), b + '\n'); res.setHeader('access-control-allow-origin', '*'); res.end('ok'); });
    return;
  }
  if (req.method === 'POST' && u.pathname === '/results') {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const run = (u.searchParams.get('run') || 'x').replace(/[^\w.-]/g, '_');
      fs.writeFileSync(path.join(dir, 'results-' + run + '.json'), b); res.end('ok'); });
    return;
  }
  const f = u.pathname === '/' ? 'lab.html' : u.pathname.slice(1);
  if (!/^[\w.-]+$/.test(f) || !fs.existsSync(path.join(dir, f))) { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream');
  fs.createReadStream(path.join(dir, f)).pipe(res);
}).listen(port, '127.0.0.1', () => console.log('lab on', port, dir));
