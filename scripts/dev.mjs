import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import './build.mjs';

const publicRoot = resolve('dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const argument = name => process.argv[process.argv.indexOf(name) + 1];
const port = Number(process.argv.includes('--port') ? argument('--port') : process.env.PORT || 5173);
const host = process.argv.includes('--host') ? argument('--host') : '127.0.0.1';
createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/.netlify/functions/sandbox-checkout' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ mode: 'sandbox', disabled: false, serverReady: false, livePaymentsEnabled: false }));
      return;
    }
    const file = resolve(publicRoot, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (!file.startsWith(`${publicRoot}/`)) throw new Error('Invalid path');
    const data = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(data);
  } catch { response.writeHead(404); response.end('Not found'); }
}).listen(port, host, () => console.log(`Local: http://${host}:${port}`));
