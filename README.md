# 公共管理议题速览

一个零依赖的纯静态网站：展示公共管理学领域最近的 **2~3 个最新议题 / 热门议题**，
附上国际顶刊的最新研究主题与中文社科动态、政策文件，并在每个议题下给出
**「拓展板块」——未来可做的选题方向**（理论视角 / 研究方法 / 数据与案例）。

网站**不需要每天自动刷新**：你什么时候想更新，跑一次抓取命令即可；
平时每次打开页面，看到的都是最近一次抓取到的近期议题，页头会标明数据日期和距今天数。

## 快速开始

```bash
# 1. 抓取数据（需要联网），生成 data/ 下的每日数据
node scripts/fetch.mjs

# 2. 启动本地服务器并浏览
node scripts/serve.mjs
# 打开 http://localhost:5173
```

也可以直接**双击 `index.html`** 浏览。此时页面读取内嵌在 `data/daily.js` 里的
最近若干天数据，不需要联网、不需要服务器（受浏览器本地文件限制，看不到更早的历史）。

想在不双击的情况下验证内嵌模式，可以访问 `http://localhost:5173/?mode=embedded`，
它走的是和双击打开完全相同的代码路径。

## 数据来源

| 来源 | 类型 | 抓取方式 | 说明 |
| --- | --- | --- | --- |
| Public Administration Review (ISSN 0033-3352) | 国际顶刊 | Crossref API | 标题、摘要、作者、DOI、发表日期 |
| Journal of Public Administration Research and Theory (1053-1858) | 国际顶刊 | Crossref API | 同上 |
| Governance (0952-1895) | 国际顶刊 | Crossref API | 同上 |
| Public Management Review (1471-9037) | 国际顶刊 | Crossref API | 同上 |
| Public Administration (0033-3298) | 国际顶刊 | Crossref API | 同上 |
| International Public Management Journal (1096-7494) | 国际顶刊 | Crossref API | 同上 |
| Policy & Politics (0305-5736) | 国际顶刊 | Crossref API | 同上 |
| Public Performance & Management Review (1530-9576) | 国际顶刊 | Crossref API | 同上 |
| Journal of Public Policy (0143-814X) | 国际顶刊 | Crossref API | 同上 |
| 中国社会科学网 · 学术观察（本网原创） | 中文动态 | 页面解析 | 学界动态、会议与议题 |
| 中国政府网 · 政策文件库 | 政策文件 | 公开检索接口 | 最新政策、发文机关、文号 |
| 《中国行政管理》(知网代码 ZXGL) | 中文顶刊 | 知网官方 RSS | 标题、作者、完整中文摘要、网络首发日期 |
| 《公共管理学报》(GGGL) | 中文顶刊 | 知网官方 RSS | 同上 |
| 《公共行政评论》(GGXZ) | 中文顶刊 | 知网官方 RSS | 同上 |
| 《行政管理改革》(XZGL) | 中文顶刊 | 知网官方 RSS | 同上 |

### 关于中文顶刊

《中国行政管理》官网的「最新目录」停更于 2022 年且接口报错，《公共管理学报》官网域名已失效，
知网检索页与万方 / 维普均为前端渲染并带反爬机制，所以**网页抓取这条路走不通**。

但知网为每本期刊提供了**官方 RSS 订阅源**（期刊详情页的「RSS订阅」），地址形如
`https://rss.cnki.net/knavi/rss/{期刊代码}`，**不需要登录**，返回标题、作者、完整中文摘要和网络首发日期。
本项目就用它来抓取中文顶刊，代码在 `scripts/fetch.mjs` 的 `fetchCnkiRss`。

需要注意两个特点：

- 每个源只返回最近约 20 条，网络首发是按批发布的，因此中文顶刊单独使用 **45 天窗口**
  （`settings.cnkiWindowDays`），与知网 RSS 的实际覆盖范围匹配；超过全局 7 天窗口的条目
  仍会作为证据参与议题计算，但权重更低。
- 想再加一本中文期刊：在知网上打开该刊详情页，点「RSS订阅」拿到期刊代码，
  然后往 `config/sources.json` 的 `cnkiJournals` 里加一条 `{ id, code, name, publisher }` 即可。

如果某本刊没有 RSS，还可以**手工维护**：在 `config/sources.json` 的 `manualEntries` 数组里
按下面格式登记条目，它们会和自动抓取结果一起进入标签匹配与议题计算。

```json
"manualEntries": [
  {
    "outlet": "中国行政管理",
    "title": "论文标题",
    "abstract": "摘要（可留空）",
    "publishedAt": "2026-10-01",
    "url": "https://...",
    "authors": ["作者A", "作者B"]
  }
]
```

## 发布上线

网站是纯静态的，发布只需要上传静态文件。先生成发布包：

```bash
node scripts/build-dist.mjs      # 等价于 npm run build
# 产出 dist/，只含 index.html、assets/、data/，不含 config/、scripts/、README
```

本地预览发布包：

```bash
node scripts/serve.mjs --root=dist --port=5174
```

然后选一种托管方式：

| 方式 | 是否需要账号 | 说明 |
| --- | --- | --- |
| Netlify Drop（app.netlify.com/drop） | 不需要 | 把 `dist` 文件夹拖进页面即可，立刻得到一个公开网址；想要能管理就再注册账号认领 |
| GitHub Pages | 需要 GitHub | 把本仓库推到 GitHub，在仓库 Settings → Pages 里选择分支和目录，适合长期维护 |
| 任意静态托管（Vercel / Cloudflare Pages / 对象存储） | 需要对应账号 | 构建命令留空或 `node scripts/build-dist.mjs`，发布目录填 `dist` |

更新线上内容的流程：先 `node scripts/fetch.mjs` 抓取新数据，再 `node scripts/build-dist.mjs`，
然后把新的 `dist/` 重新上传（Netlify Drop 支持直接拖新的文件夹覆盖）。

## 什么时候需要再跑一次抓取

不配置任何定时任务。议题的时效性来自抓取窗口本身（国际顶刊近 7 天、中文顶刊近 45 天、
中文动态与政策近 7 天），所以隔几天跑一次 `node scripts/fetch.mjs`，打开网站时看到的
仍然是「近期」议题，不会因为没更新而失效。

抓取结果按日期存进 `data/daily/YYYY-MM-DD.json`，多跑几天就自然积累成往期归档，
首页底部的「历史归档」可以按日期回看。

如果以后确实想要定时自动抓取，自己加一个 Windows 计划任务指向
`node scripts/fetch.mjs` 即可（`scripts/` 下已不再内置注册脚本）。

## 目录结构

```
index.html              网站首页（单页）
assets/styles.css       样式
assets/app.js           前端渲染与筛选逻辑
config/sources.json     期刊 ISSN 清单、中文源地址、可调参数、手工条目
config/topics.json      议题词典（中英关键词 → 标签）
config/ideas.json       选题知识库（标签 → 未来选题方向）
scripts/fetch.mjs       抓取 + 打标签 + 热度计算 + 生成数据
scripts/serve.mjs       本地静态服务器
data/daily/<日期>.json  每日完整数据
data/archive.json       历史日期索引
data/meta.json          数据源状态与最近运行信息
data/daily.js           内嵌数据（供双击打开使用，自动生成）
```

## 议题是怎么算出来的

1. **抓取**：按 ISSN 拉取近 7 天国际顶刊文章，解析中文动态与政策文件。
2. **打标签**：用 `config/topics.json` 的中英关键词匹配标题与摘要，命中即打上议题标签。
3. **算热度**：近 7 天内命中条目越多、越新，热度分越高，来源越多额外加权。
4. **选议题**：取热度最高的 2~3 个标签作为当日议题；与前一日重复的标签会被让位给新标签。
5. **定性质**：近 3 天有新条目且昨日未出现 → 标记为「最新」，否则标记为「热门」。
6. **拓展板块**：按日期从 `config/ideas.json` 轮换取 3 条未来选题方向。

## 如何扩展

- **加议题**：在 `config/topics.json` 加一条（含 `id`、`label`、`summary`、中英关键词），
  再到 `config/ideas.json` 用同一个 `id` 补上选题方向即可。
- **加期刊**：在 `config/sources.json` 的 `internationalJournals` 里按 `{ id, issn, name, nameZh }` 追加。
- **加中文源**：需要先写对应的解析器（`scripts/fetch.mjs` 中的 `fetchCssn` / `fetchGovPolicy` 样式），
  再在 `chineseSources` 里登记。
- **调节频率与数量**：`settings.maxTopicsPerDay`、`minTopicsPerDay`、`windowDays`、`entriesPerTopic`、`ideasPerTopic`。

## 常用命令

```bash
node scripts/fetch.mjs --verbose        # 输出详细日志
node scripts/fetch.mjs --offline        # 不联网，复用最近一次抓取结果重建索引与内嵌数据
node scripts/fetch.mjs --date=2026-10-06  # 指定日期（调试用）
node scripts/serve.mjs --port=8080      # 指定端口
```

`--offline` 只复用本地已有的每日数据重新计算（适合改了关键词或选题库之后快速重建），
它不会写入空数据，也不会凭空创建新的日期。

## 关于统计窗口

默认统计窗口是 7 天（`settings.windowDays`）。部分期刊按双月刊/季刊成批上线，例如
**Governance** 的最新一期是 9 月 22 日，在 7 天窗口内就可能一条都取不到，属于正常现象。
希望覆盖更稳的话，把 `windowDays` 调到 14~21 即可；代价是"最新"的时效性会弱一些。

## 免责说明

本站只做学术议题的聚合与选题启发，文献标题、摘要与版权归原作者及出版机构所有；
政策文件来自中国政府网公开信息。请以期刊官网与政府网站原文为准。
