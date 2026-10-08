#!/usr/bin/env node
/**
 * 极简静态服务器（零依赖）。
 *
 * 用法：
 *   node scripts/serve.mjs            默认 http://localhost:5173
 *   node scripts/serve.mjs --port=8080
 *   node scripts/serve.mjs --root=dist 只发布 dist 目录（例如发布包），默认整个项目目录
 */

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith('--port='));
const rootArg = args.find((a) => a.startsWith('--root='));
const PORT = Number(portArg ? portArg.split('=')[1] : process.env.PORT || 5173);
const ROOT = rootArg ? path.resolve(process.cwd(), rootArg.slice('--root='.length)) : PROJECT_ROOT;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
    let target = path.join(ROOT, urlPath);
    const resolved = path.resolve(target);
    if (!resolved.startsWith(ROOT)) return send(res, 403, 'Forbidden');

    let info = await stat(resolved).catch(() => null);
    if (info?.isDirectory()) {
      target = path.join(resolved, 'index.html');
      info = await stat(target).catch(() => null);
    }
    if (!info?.isFile()) {
      return send(res, 404, '404 Not Found', 'text/plain; charset=utf-8');
    }

    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': info.size,
    });
    createReadStream(target).pipe(res);
  } catch (err) {
    send(res, 500, `500 ${err.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`公共管理议题速览已启动：http://localhost:${PORT}`);
  console.log(`对外目录：${ROOT}`);
  console.log('按 Ctrl+C 停止服务。');
});
