#!/usr/bin/env node
// Local bridge for an unpacked TexTone install:
//   GET  /state    -> { version, command }  (polled by the service worker)
//   POST /log      <- debug entries, appended to tmp/textone-debug.log
//   POST /command  <- { type: 'start' | 'stop', reloadTab?, settleMs? }
// The extension reloads itself when `version` changes, i.e. when any file in
// extension/ is edited.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { appendFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(new URL('../..', import.meta.url).pathname);
const extensionDir = join(root, 'extension');
const logFile = '/tmp/textone-debug.log';
// 18802/18803 are taken by the LAN GPU SSH tunnel.
const port = Number(process.env.PORT || 18810);

let command = null;
const walkFiles = (dir, prefix = '') => {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walkFiles(full, rel));
    else if (stat.isFile()) out.push({ rel, stat });
  }
  return out;
};
const version = () => {
  const hash = createHash('sha1');
  for (const { rel, stat } of walkFiles(extensionDir)) {
    hash.update(`${rel}:${stat.size}:${stat.mtimeMs}\n`);
  }
  return hash.digest('hex').slice(0, 12);
};
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Private-Network': 'true',
  'Cache-Control': 'no-store',
};
const body = request => new Promise((done, fail) => {
  let data = '';
  request.on('data', chunk => { data += chunk; if (data.length > 2_000_000) request.destroy(); });
  request.on('end', () => done(data));
  request.on('error', fail);
});

createServer(async (request, response) => {
  try {
    if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
    if (request.method === 'GET' && request.url === '/state') {
      response.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ version: version(), command }));
      return;
    }
    if (request.method === 'POST' && request.url === '/log') {
      const raw = await body(request);
      appendFileSync(logFile, `${raw}\n`);
      try {
        const entry = JSON.parse(raw);
        const { at, event, ...data } = entry;
        console.log(`${at?.slice(11, 23)} ${event} ${JSON.stringify(data).slice(0, 600)}`);
      } catch { console.log(raw.slice(0, 600)); }
      response.writeHead(204, headers); response.end();
      return;
    }
    if (request.method === 'POST' && request.url === '/command') {
      const next = JSON.parse(await body(request) || '{}');
      command = { ...next, id: `${Date.now()}` };
      console.log(`>>> command ${JSON.stringify(command)}`);
      response.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      response.end(JSON.stringify(command));
      return;
    }
    response.writeHead(404, headers); response.end();
  } catch (error) {
    response.writeHead(500, headers); response.end(String(error));
  }
}).listen(port, '127.0.0.1', () => console.log(`TexTone dev bridge on http://localhost:${port} · log ${logFile}`));
