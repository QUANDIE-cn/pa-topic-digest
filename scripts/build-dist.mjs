#!/usr/bin/env node
/**
 * 生成发布包 dist/：只包含网站运行需要的静态文件，
 * 不含 config/、scripts/、README 等开发文件。
 *
 * 用法：node scripts/build-dist.mjs
 */

import { rm, mkdir, cp, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const ITEMS = ['index.html', 'assets', 'data'];

async function dirSize(dir) {
  let total = 0;
  let files = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await dirSize(full);
      total += sub.total;
      files += sub.files;
    } else {
      total += (await stat(full)).size;
      files += 1;
    }
  }
  return { total, files };
}

async function main() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  for (const item of ITEMS) {
    await cp(path.join(ROOT, item), path.join(DIST, item), { recursive: true });
  }

  const { total, files } = await dirSize(DIST);
  console.log(`发布包已生成：dist/（${files} 个文件，${(total / 1024).toFixed(1)} KB）`);
  console.log('本地预览：node scripts/serve.mjs --root=dist --port=5174');
  console.log('发布方式：把 dist/ 整个目录（或打包成 zip）上传到任意静态托管即可。');
}

main().catch((err) => {
  console.error('生成发布包失败：', err);
  process.exitCode = 1;
});
