#!/usr/bin/env node
/**
 * 公共管理议题速览 · 数据抓取与生成流水线
 *
 * 零第三方依赖，仅使用 Node 18+ 内置能力（fetch / fs / url）。
 *
 * 用法：
 *   node scripts/fetch.mjs                 正常抓取并生成当日数据
 *   node scripts/fetch.mjs --offline       不联网，仅用本地已有数据重建索引与内嵌数据
 *   node scripts/fetch.mjs --date=2026-10-06   覆盖“今天”的日期（便于测试）
 *   node scripts/fetch.mjs --verbose       输出详细日志
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(ROOT, 'config');
const DATA_DIR = path.join(ROOT, 'data');
const DAILY_DIR = path.join(DATA_DIR, 'daily');

// ---------------------------------------------------------------- CLI 参数

const argv = process.argv.slice(2);
const FLAGS = {
  offline: argv.includes('--offline'),
  verbose: argv.includes('--verbose') || argv.includes('-v'),
  dateArg: (argv.find((a) => a.startsWith('--date=')) || '').split('=')[1] || null,
};

function log(...args) {
  if (FLAGS.verbose) console.log('[verbose]', ...args);
}

// ---------------------------------------------------------------- 通用工具

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isoDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 把 "2026.09.30" / "2026-09-30" / "2026年9月30日" 统一成 YYYY-MM-DD */
function normalizeDateString(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/(\d{4})[-./年](\d{1,2})[-./月](\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = s.match(/(\d{8})/);
  if (m) return `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`;
  return null;
}

function dateFromParts(parts) {
  if (!Array.isArray(parts) || !parts.length) return { date: null, precision: 'unknown' };
  const [y, mo, d] = parts;
  if (!y) return { date: null, precision: 'unknown' };
  if (!mo) return { date: `${y}-01-01`, precision: 'year' };
  if (!d) return { date: `${y}-${pad2(mo)}-01`, precision: 'month' };
  return { date: `${y}-${pad2(mo)}-${pad2(d)}`, precision: 'day' };
}

function diffDays(fromISO, toISO) {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/gi, '&');
}

function stripTags(input) {
  if (!input) return '';
  return decodeEntities(String(input).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function httpGet(url, { as = 'text', headers = {}, timeoutMs = 25000, retries = 1 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': BROWSER_UA, Accept: '*/*', ...headers },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (as === 'json') return { data: await res.json(), status: res.status };
      return { data: await res.text(), status: res.status };
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      log(`请求失败（第 ${attempt + 1} 次）：${url} → ${err.message}`);
      if (attempt < retries) await sleep(700 * (attempt + 1));
    }
  }
  throw lastError || new Error('请求失败');
}

// ---------------------------------------------------------------- 噪声过滤

const NOISE_TITLE_RE =
  /^(correction|corrigendum|erratum|editorial board|front matter|back matter|issue information|table of contents|list of reviewers|acknowledg)/i;

function isNoiseTitle(title) {
  if (!title) return true;
  return NOISE_TITLE_RE.test(title.trim());
}

// ---------------------------------------------------------------- 数据源抓取

async function fetchCrossref(journal, { settings, fromDate }) {
  const params = new URLSearchParams({
    filter: `from-pub-date:${fromDate},type:journal-article`,
    sort: 'published',
    order: 'desc',
    rows: String(settings.rowsPerJournal),
    mailto: settings.mailto,
  });
  const url = `https://api.crossref.org/journals/${encodeURIComponent(journal.issn)}/works?${params}`;

  let items = [];
  try {
    const { data } = await httpGet(url, {
      as: 'json',
      headers: { Accept: 'application/json' },
      timeoutMs: settings.requestTimeoutMs,
      retries: settings.retries,
    });
    items = data?.message?.items || [];
  } catch (err) {
    log(`Crossref 过滤查询失败，尝试不带日期过滤：${journal.issn} → ${err.message}`);
  }

  if (!items.length) {
    const fallback = new URLSearchParams({
      sort: 'published',
      order: 'desc',
      rows: String(settings.rowsPerJournal),
      mailto: settings.mailto,
    });
    const { data } = await httpGet(
      `https://api.crossref.org/journals/${encodeURIComponent(journal.issn)}/works?${fallback}`,
      {
        as: 'json',
        headers: { Accept: 'application/json' },
        timeoutMs: settings.requestTimeoutMs,
        retries: settings.retries,
      },
    );
    items = data?.message?.items || [];
  }

  return items
    .map((raw) => {
      const title = stripTags((raw.title || [])[0] || '');
      if (!title || isNoiseTitle(title)) return null;
      const { date, precision } = dateFromParts((raw.published || raw['published-online'] || raw.issued || {})['date-parts']?.[0]);
      const authors = (raw.author || [])
        .map((a) => [a.given, a.family].filter(Boolean).join(' ').trim() || a.name || '')
        .filter(Boolean);
      const doi = raw.DOI || null;
      return {
        id: doi ? `doi:${doi}` : `cr:${hashString(title + journal.issn)}`,
        lang: 'en',
        sourceType: 'journal',
        sourceId: journal.id,
        outlet: journal.name,
        outletZh: journal.nameZh,
        title,
        abstract: truncate(stripTags(raw.abstract || ''), 900),
        authors,
        publishedAt: date,
        datePrecision: precision,
        windowDays: settings.windowDays,
        url: raw.URL || (doi ? `https://doi.org/${doi}` : ''),
        doi,
      };
    })
    .filter(Boolean);
}

async function fetchCssn(source, { settings }) {
  const { data: html } = await httpGet(source.url, {
    headers: { Accept: 'text/html' },
    timeoutMs: settings.requestTimeoutMs,
    retries: settings.retries,
  });

  const seen = new Set();
  const items = [];
  const re = /<a\b[^>]*href=["']\s*\.?\/?(\d{6})\/(t(\d{8})_\d+\.shtml)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m = re.exec(html);
  while (m) {
    const [, yearMonth, fileName, compact, inner] = m;
    const title = stripTags(inner);
    const publishedAt = normalizeDateString(compact);
    const url = `https://www.cssn.cn/skgz/bwyc/${yearMonth}/${fileName}`;
    if (title.length >= 6 && publishedAt && !seen.has(title)) {
      seen.add(title);
      items.push({
        id: `cssn:${compact}_${hashString(title)}`,
        lang: 'zh',
        sourceType: 'news',
        sourceId: source.id,
        outlet: '中国社会科学网',
        outletZh: '中国社会科学网 · 学术观察',
        title,
        abstract: '',
        summary: '中国社会科学网学术观察（本网原创），聚焦学界动态、会议与学术议题。',
        authors: [],
        publishedAt,
        datePrecision: 'day',
        url,
        doi: null,
      });
    }
    m = re.exec(html);
  }
  return items;
}

async function fetchGovPolicy(source, { settings }) {
  const { data } = await httpGet(source.url, {
    as: 'json',
    headers: { Accept: 'application/json' },
    timeoutMs: settings.requestTimeoutMs,
    retries: settings.retries,
  });

  const list = data?.searchVO?.listVO || [];
  return list
    .map((raw) => {
      const title = stripTags(raw.title || '');
      const publishedAt = normalizeDateString(raw.pubtimeStr || raw.pubtime);
      if (!title || !publishedAt) return null;
      const summary = stripTags(raw.summary || '');
      return {
        id: `gov:${raw.id || hashString(title)}`,
        lang: 'zh',
        sourceType: 'policy',
        sourceId: source.id,
        outlet: '中国政府网',
        outletZh: '中国政府网 · 政策文件库',
        title,
        abstract: truncate(summary, 600),
        summary,
        docNumber: stripTags(raw.pcode || raw.wenhao || ''),
        org: stripTags(raw.puborg || raw.fwdw || ''),
        category: stripTags(raw.childtype || ''),
        authors: [],
        publishedAt,
        datePrecision: 'day',
        url: raw.url || '',
        doi: null,
      };
    })
    .filter(Boolean);
}

/**
 * 知网（CNKI）期刊官方 RSS 订阅源。
 * 地址形如 https://rss.cnki.net/knavi/rss/{期刊代码}，返回中文的标题、作者、完整摘要与网络首发日期，
 * 无需登录，因此可以稳定用于自动抓取中文顶刊。
 */
function parseRssPubDate(raw) {
  if (!raw) return null;
  const t = Date.parse(String(raw).trim());
  if (Number.isNaN(t)) return null;
  // CNKI 的 pubDate 是北京时间零点以 GMT 表示（前一日 16:00Z），加 8 小时还原为北京日期
  const d = new Date(t + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function rssTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return '';
  return decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
}

async function fetchCnkiRss(journal, { settings }) {
  const { data: xml } = await httpGet(`https://rss.cnki.net/knavi/rss/${encodeURIComponent(journal.code)}`, {
    headers: { Accept: 'application/xml,text/xml,*/*' },
    timeoutMs: settings.requestTimeoutMs,
    retries: settings.retries,
  });

  const windowDays = journal.windowDays || settings.cnkiWindowDays || settings.windowDays;
  const maxItems = journal.maxItems || settings.cnkiMaxItems || 12;
  const blocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);

  return blocks
    .slice(0, maxItems)
    .map((block) => {
      const title = rssTag(block, 'title');
      const link = rssTag(block, 'link');
      const description = stripTags(rssTag(block, 'description'));
      const authors = rssTag(block, 'author')
        .split(/[;；]/)
        .map((a) => a.trim())
        .filter(Boolean);
      const publishedAt = parseRssPubDate(rssTag(block, 'pubDate'));
      if (!title || !publishedAt) return null;
      return {
        id: `cnki:${journal.code}:${hashString(title)}`,
        lang: 'zh',
        sourceType: 'cnjournal',
        sourceId: journal.id,
        outlet: journal.name,
        outletZh: `《${journal.name}》`,
        publisher: journal.publisher || '',
        title,
        abstract: truncate(description, 900),
        authors,
        publishedAt,
        datePrecision: 'day',
        windowDays,
        url: link,
        doi: null,
      };
    })
    .filter(Boolean);
}

async function fetchManualEntries(entries) {
  return (entries || [])
    .filter((e) => e && e.title)
    .map((e) => ({
      id: e.id || `manual:${hashString((e.title || '') + (e.outlet || ''))}`,
      lang: 'zh',
      sourceType: 'journal',
      sourceId: 'manual',
      outlet: e.outlet || '手工录入',
      outletZh: e.outlet || '手工录入',
      title: e.title,
      abstract: truncate(stripTags(e.abstract || ''), 900),
      authors: e.authors || [],
      publishedAt: normalizeDateString(e.publishedAt),
      datePrecision: 'day',
      url: e.url || '',
      doi: null,
    }));
}

// ---------------------------------------------------------------- 标签匹配

function buildMatchers(topics) {
  return topics.map((topic) => {
    const zh = (topic.keywords?.zh || []).map((k) => k.trim()).filter(Boolean);
    const en = (topic.keywords?.en || []).map((k) => k.trim().toLowerCase()).filter(Boolean);
    const enRegex = en.map(
      (k) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(k)}($|[^a-z0-9])`, 'i'),
    );
    return { topic, zh, en, enRegex };
  });
}

function tagEntry(entry, matchers) {
  const hayZh = `${entry.title} ${entry.abstract || ''} ${entry.summary || ''} ${entry.category || ''}`;
  const hayEn = hayZh.toLowerCase();
  const hits = [];

  for (const { topic, zh, en, enRegex } of matchers) {
    let score = 0;
    for (const kw of zh) if (hayZh.includes(kw)) score += CJK_RE.test(kw) ? 1.5 : 1;
    for (let i = 0; i < en.length; i += 1) {
      if (enRegex[i].test(hayEn)) score += en[i].split(/\s+/).length > 1 ? 2 : 1;
    }
    if (score > 0) hits.push({ id: topic.id, label: topic.label, score: Math.min(score, 8) });
  }

  hits.sort((a, b) => b.score - a.score);
  entry.tagIds = hits.map((h) => h.id);
  entry.tags = hits.map((h) => h.label);
  entry.tagScore = Object.fromEntries(hits.map((h) => [h.id, h.score]));
  entry.summaryZh = hits.length
    ? `涉及${hits.slice(0, 3).map((h) => h.label).join('、')}`
    : '暂未匹配到既有议题标签';
  return entry;
}

// ---------------------------------------------------------------- 议题构建

function recencyWeight(entry, today, windowDays) {
  if (!entry.publishedAt) return 0.4;
  const span = entry.windowDays || windowDays;
  const days = diffDays(entry.publishedAt, today);
  if (days === null) return 0.4;
  if (entry.datePrecision === 'month') return 0.5;
  if (entry.datePrecision === 'year') return 0.35;
  const clamped = Math.max(0, Math.min(days, span));
  // 下限 0.3：超出全局新鲜度窗口但仍在来源窗口内的条目仍然计为证据，只是权重更低
  return Number(Math.max(0.3, 1 - (clamped / span) * 0.65).toFixed(3));
}

function pickRepresentativeEntries(entries, limit) {
  const byOutlet = new Map();
  const sorted = [...entries].sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
  for (const e of sorted) {
    const key = e.outletZh || e.outlet || '其他';
    if (!byOutlet.has(key)) byOutlet.set(key, []);
    byOutlet.get(key).push(e);
  }
  const buckets = [...byOutlet.values()];
  const picked = [];
  let round = 0;
  while (picked.length < limit && buckets.some((b) => b.length > round)) {
    for (const b of buckets) {
      if (picked.length >= limit) break;
      if (b[round]) picked.push(b[round]);
    }
    round += 1;
  }
  return picked;
}

function pickIdeas(ideas, dateStr, topicId, count) {
  if (!Array.isArray(ideas) || !ideas.length) return [];
  const start = parseInt(hashString(`${dateStr}|${topicId}`), 36) % ideas.length;
  const out = [];
  for (let i = 0; i < Math.min(count, ideas.length); i += 1) {
    out.push(ideas[(start + i) % ideas.length]);
  }
  return out;
}

function buildTopics({ entries, topics, ideasMap, today, settings, previousLabels }) {
  const perTopic = new Map();
  for (const topic of topics) {
    perTopic.set(topic.id, { topic, entries: [], hotScore: 0, recent3: 0 });
  }

  for (const entry of entries) {
    const weight = recencyWeight(entry, today, settings.windowDays);
    const days = entry.publishedAt ? diffDays(entry.publishedAt, today) : null;
    for (const tagId of entry.tagIds || []) {
      const bucket = perTopic.get(tagId);
      if (!bucket) continue;
      bucket.entries.push(entry);
      bucket.hotScore += weight;
      if (days !== null && days >= 0 && days <= 3) bucket.recent3 += 1;
    }
  }

  const ranked = [...perTopic.values()]
    .filter((b) => b.entries.length > 0)
    .map((b) => {
      const outlets = new Set(b.entries.map((e) => e.outletZh || e.outlet));
      b.hotScore = Number((b.hotScore + 0.15 * Math.max(0, outlets.size - 1)).toFixed(2));
      b.outletCount = outlets.size;
      return b;
    })
    .sort((a, b) => b.hotScore - a.hotScore || b.entries.length - a.entries.length);

  const previous = new Set(previousLabels || []);
  const fresh = ranked.filter((b) => !previous.has(b.topic.id));
  const reused = ranked.filter((b) => previous.has(b.topic.id));

  const selected = [...fresh.slice(0, settings.maxTopicsPerDay)];
  if (selected.length < settings.maxTopicsPerDay) {
    selected.push(...reused.slice(0, settings.maxTopicsPerDay - selected.length));
  }
  selected.sort((a, b) => b.hotScore - a.hotScore);

  return selected.map((bucket) => {
    const byType = { journal: 0, cnjournal: 0, news: 0, policy: 0 };
    for (const e of bucket.entries) byType[e.sourceType] = (byType[e.sourceType] || 0) + 1;
    const kind = bucket.recent3 > 0 && !previous.has(bucket.topic.id) ? '最新' : '热门';
    const outlets = [...new Set(bucket.entries.map((e) => e.outletZh || e.outlet))]
      .map((name) => ({ name, count: bucket.entries.filter((e) => (e.outletZh || e.outlet) === name).length }))
      .sort((a, b) => b.count - a.count);

    return {
      id: bucket.topic.id,
      label: bucket.topic.label,
      summary: bucket.topic.summary,
      kind,
      hotScore: bucket.hotScore,
      entryCount: bucket.entries.length,
      recent3Count: bucket.recent3,
      outletCount: bucket.outletCount,
      typeBreakdown: byType,
      outlets,
      whyHot:
        `近 ${settings.windowDays} 天共命中 ${bucket.entries.length} 条，覆盖 ${bucket.outletCount} 个来源` +
        `（国际顶刊 ${byType.journal || 0} 篇 / 中文动态 ${byType.news || 0} 条 / 政策文件 ${byType.policy || 0} 条），` +
        `其中 ${bucket.recent3} 条发布于近 3 天。`,
      entries: pickRepresentativeEntries(bucket.entries, settings.entriesPerTopic),
      ideas: pickIdeas(ideasMap[bucket.topic.id], today, bucket.topic.id, settings.ideasPerTopic),
    };
  });
}

// ---------------------------------------------------------------- 读写数据

async function readJsonIfExists(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function loadRecentDailyFiles(days) {
  if (!existsSync(DAILY_DIR)) return {};
  const files = (await readdir(DAILY_DIR))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .reverse()
    .slice(0, days);
  const out = {};
  for (const f of files) {
    out[f.replace('.json', '')] = await readJsonIfExists(path.join(DAILY_DIR, f), null);
  }
  return out;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const startedAt = Date.now();
  const sources = await readJsonIfExists(path.join(CONFIG_DIR, 'sources.json'), null);
  const topicConfig = await readJsonIfExists(path.join(CONFIG_DIR, 'topics.json'), null);
  const ideaConfig = await readJsonIfExists(path.join(CONFIG_DIR, 'ideas.json'), null);

  if (!sources || !topicConfig || !ideaConfig) {
    throw new Error('缺少或无法解析 config/sources.json、config/topics.json、config/ideas.json');
  }

  const settings = { retries: 1, concurrency: 4, requestTimeoutMs: 25000, ...sources.settings };
  const metaPath = path.join(DATA_DIR, 'meta.json');
  const archivePath = path.join(DATA_DIR, 'archive.json');
  let today = FLAGS.dateArg || isoDate(new Date());
  let fromDate = addDays(today, -settings.windowDays);
  const topics = topicConfig.topics || [];
  const ideasMap = ideaConfig.ideas || {};
  const matchers = buildMatchers(topics);

  console.log(`=== 公共管理议题速览 · ${today}（窗口 ${settings.windowDays} 天，起始 ${fromDate}）===`);

  const sourceStatus = [];
  let entries = [];

  if (FLAGS.offline) {
    // 离线模式：复用本地已有的每日数据重建索引，绝不写入空数据、不新增日期。
    const recent = await loadRecentDailyFiles(30);
    const dates = Object.keys(recent).sort();
    const target = FLAGS.dateArg && recent[FLAGS.dateArg] ? FLAGS.dateArg : dates[dates.length - 1];
    if (!target) {
      console.error('! 离线模式需要至少一份已有的每日数据（data/daily/YYYY-MM-DD.json）。请先联网执行一次 node scripts/fetch.mjs。');
      process.exitCode = 1;
      return;
    }
    today = target;
    fromDate = addDays(today, -settings.windowDays);
    entries = recent[target].entries || [];
    console.log(`· 离线模式：跳过网络抓取，复用 ${target} 已有的 ${entries.length} 条条目`);
    const prevMeta = await readJsonIfExists(metaPath, null);
    if (prevMeta && Array.isArray(prevMeta.sourceStatus)) sourceStatus.push(...prevMeta.sourceStatus);
  } else {
    const journalTasks = (sources.internationalJournals || []).map((journal) => async () => {
      const t0 = Date.now();
      try {
        const items = await fetchCrossref(journal, { settings, fromDate });
        console.log(`· ${journal.name}: ${items.length} 篇`);
        return { status: { id: journal.id, name: journal.name, type: 'journal', ok: true, count: items.length, ms: Date.now() - t0 }, items };
      } catch (err) {
        console.warn(`! ${journal.name} 抓取失败：${err.message}`);
        return { status: { id: journal.id, name: journal.name, type: 'journal', ok: false, count: 0, error: err.message, ms: Date.now() - t0 }, items: [] };
      }
    });

    const chineseTasks = (sources.chineseSources || [])
      .filter((s) => s.enabled !== false)
      .map((source) => async () => {
        const t0 = Date.now();
        try {
          const items =
            source.parser === 'cssn'
              ? await fetchCssn(source, { settings })
              : await fetchGovPolicy(source, { settings });
          console.log(`· ${source.name}: ${items.length} 条`);
          return { status: { id: source.id, name: source.name, type: source.type, ok: true, count: items.length, ms: Date.now() - t0 }, items };
        } catch (err) {
          console.warn(`! ${source.name} 抓取失败：${err.message}`);
          return { status: { id: source.id, name: source.name, type: source.type, ok: false, count: 0, error: err.message, ms: Date.now() - t0 }, items: [] };
        }
      });

    const cnkiTasks = (sources.cnkiJournals || [])
      .filter((j) => j.enabled !== false && j.code)
      .map((journal) => async () => {
        const t0 = Date.now();
        try {
          const items = await fetchCnkiRss(journal, { settings });
          console.log(`· 《${journal.name}》(知网RSS): ${items.length} 篇`);
          return { status: { id: journal.id, name: journal.name, type: 'cnjournal', ok: true, count: items.length, ms: Date.now() - t0 }, items };
        } catch (err) {
          console.warn(`! 《${journal.name}》 抓取失败：${err.message}`);
          return { status: { id: journal.id, name: journal.name, type: 'cnjournal', ok: false, count: 0, error: err.message, ms: Date.now() - t0 }, items: [] };
        }
      });

    const results = await mapLimit([...journalTasks, ...cnkiTasks, ...chineseTasks], settings.concurrency, (task) => task());
    for (const r of results) {
      sourceStatus.push(r.status);
      entries.push(...r.items);
    }

    const manual = await fetchManualEntries(sources.manualEntries);
    if (manual.length) console.log(`· 手工录入条目: ${manual.length} 条`);
    entries.push(...manual);
  }

  // 去重（按 id 与标题）
  const dedup = new Map();
  for (const e of entries) {
    const key = e.id || e.title;
    if (!dedup.has(key)) dedup.set(key, e);
  }
  entries = [...dedup.values()];

  // 窗口过滤
  // 说明：部分期刊（如 Governance）在 Crossref 里的 published 是“期号日期”，
  // 可能晚于当前日期（在线优先、待编入未来某一期）。这类条目按月份精度保留，
  // 否则整本期刊会被误过滤掉；年份精度过于含糊则丢弃。
  entries = entries.filter((e) => {
    if (!e.publishedAt) return true;
    const days = diffDays(e.publishedAt, today);
    if (days === null) return true;
    const w = e.windowDays || settings.windowDays;
    if (e.datePrecision === 'day') return days >= -2 && days <= w;
    if (e.datePrecision === 'month') return days >= -150 && days <= w + 30;
    return false;
  });

  entries = entries.map((e) => tagEntry(e, matchers));
  entries.sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));

  const archive = await readJsonIfExists(archivePath, []);
  const previousLabels = (archive.find((a) => a.date < today) || {}).topicLabels || [];

  const selectedTopics = buildTopics({ entries, topics, ideasMap, today, settings, previousLabels });

  const okSources = sourceStatus.filter((s) => s.ok).length;
  const failedSources = sourceStatus.filter((s) => !s.ok);
  const totalEntries = entries.length;
  const success = totalEntries > 0;

  console.log(
    `\n抓取结果：${totalEntries} 条条目，${selectedTopics.length} 个议题，` +
      `数据源 ${okSources}/${sourceStatus.length} 成功${failedSources.length ? `（失败：${failedSources.map((s) => s.name).join('、')}）` : ''}`,
  );

  if (!success) {
    const meta = {
      lastRunAt: new Date().toISOString(),
      lastRunDate: today,
      lastRunOk: false,
      windowDays: settings.windowDays,
      message: '本次抓取没有获得任何条目，未覆盖已有数据。请检查网络连接后重试。',
      sourceStatus,
      failedSources: sourceStatus.filter((s) => !s.ok).map((s) => s.name),
      stats: { entries: 0, topics: 0, sourcesOk: 0, sourcesTotal: sourceStatus.length },
      durationMs: Date.now() - startedAt,
    };
    await writeJson(metaPath, meta);
    console.error('! 未获得任何条目，已写入失败状态的 meta.json，保留原有每日数据。');
    process.exitCode = 1;
    return;
  }

  const dailyPayload = {
    date: today,
    generatedAt: new Date().toISOString(),
    windowDays: settings.windowDays,
    windows: { international: settings.windowDays, cnki: settings.cnkiWindowDays || settings.windowDays },
    rangeFrom: fromDate,
    stats: {
      entries: totalEntries,
      topics: selectedTopics.length,
      journals: sourceStatus.filter((s) => (s.type === 'journal' || s.type === 'cnjournal') && s.ok && s.count > 0).length,
      sourcesOk: okSources,
      sourcesTotal: sourceStatus.length,
    },
    topics: selectedTopics,
    entries,
  };

  await writeJson(path.join(DAILY_DIR, `${today}.json`), dailyPayload);

  const archiveEntry = {
    date: today,
    generatedAt: dailyPayload.generatedAt,
    topicLabels: selectedTopics.map((t) => t.label),
    topicIds: selectedTopics.map((t) => t.id),
    entryCount: totalEntries,
    sourcesOk: okSources,
    sourcesTotal: sourceStatus.length,
    ok: okSources > 0,
  };
  // 过滤掉历史遗留的空记录（正常流程下 entryCount 为 0 的日期不会写入）
  const nextArchive = [archiveEntry, ...archive.filter((a) => a.date !== today && (a.entryCount || 0) > 0)]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, settings.archiveLimit);
  await writeJson(archivePath, nextArchive);

  const meta = {
    lastRunAt: dailyPayload.generatedAt,
    lastRunDate: today,
    lastRunOk: failedSources.length === 0,
    windowDays: settings.windowDays,
    sourceStatus,
    stats: dailyPayload.stats,
    durationMs: Date.now() - startedAt,
    failedSources: failedSources.map((s) => s.name),
  };
  await writeJson(metaPath, meta);

  const recentByDate = await loadRecentDailyFiles(settings.embedDays);
  recentByDate[today] = dailyPayload;
  const days = Object.keys(recentByDate).sort().reverse().slice(0, settings.embedDays);
  const bundle = {
    generatedAt: meta.lastRunAt,
    latestDate: today,
    meta,
    archive: nextArchive.slice(0, 60),
    byDate: Object.fromEntries(days.map((d) => [d, recentByDate[d]])),
  };
  // 注意：这里必须直接写文件，不能走 writeJson——否则整段脚本会被再转义成一个 JSON 字符串。
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(
    path.join(DATA_DIR, 'daily.js'),
    `/* 自动生成，请勿手工编辑。由 scripts/fetch.mjs 于 ${meta.lastRunAt} 生成。 */\nwindow.__PA_DATA__ = ${JSON.stringify(bundle)};\n`,
    'utf8',
  );

  console.log(`已写入 data/daily/${today}.json、data/archive.json、data/meta.json、data/daily.js`);
  if (selectedTopics.length) {
    console.log('\n今日议题：');
    for (const t of selectedTopics) {
      console.log(`  [${t.kind}] ${t.label}（热度 ${t.hotScore}，${t.entryCount} 条 / ${t.outletCount} 个来源）`);
    }
  }
  console.log(`\n耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒。`);
}

main().catch((err) => {
  console.error('抓取流程异常终止：', err);
  process.exitCode = 1;
});
