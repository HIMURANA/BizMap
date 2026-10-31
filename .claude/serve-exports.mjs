// Minimal static server for data/exports (used by the browser preview to view dashboard.html).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..', 'data', 'exports');
const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.csv': 'text/csv; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };
createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = resolve(root, '.' + (path === '/' ? '/dashboard.html' : path));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  let body;
  try { body = await readFile(file); } catch { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
}).listen(4173, '127.0.0.1');
