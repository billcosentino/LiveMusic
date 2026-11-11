// Tiny static server for site/ (optional — index.html also opens directly from disk).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { SITE } from './util.js';

const PORT = +process.env.PORT || 8080;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ics': 'text/calendar', '.json': 'application/json' };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(SITE, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(SITE)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': (TYPES[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}).listen(PORT, () => console.log(`Calendar at http://localhost:${PORT}`));
