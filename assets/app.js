/* 公共管理议题速览 · 前端渲染 */
(function () {
  'use strict';

  var TYPE_LABELS = {
    journal: '国际顶刊',
    cnjournal: '中文顶刊',
    news: '中文动态',
    policy: '政策文件',
  };
  var ALL_TYPES = ['journal', 'cnjournal', 'news', 'policy'];
  var WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  var state = {
    meta: null,
    archive: [],
    byDate: {},
    date: null,
    daily: null,
    types: new Set(ALL_TYPES),
    tags: new Set(),
    liveMode: false,
    pinnedDate: false,
  };

  // ------------------------------------------------------------ 基础工具

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function $(id) {
    return document.getElementById(id);
  }

  function todayISO() {
    var d = new Date();
    var p = function (n) {
      return String(n).padStart(2, '0');
    };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    var parts = String(iso).split('-');
    if (parts.length !== 3) return iso;
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return parts[0] + '年' + Number(parts[1]) + '月' + Number(parts[2]) + '日 ' + WEEKDAYS[d.getDay()];
  }

  function fmtShort(iso) {
    if (!iso) return '—';
    var parts = String(iso).split('-');
    return parts.length === 3 ? Number(parts[1]) + '/' + Number(parts[2]) : iso;
  }

  function fmtDateTime(value) {
    if (!value) return '—';
    var d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    var p = function (n) {
      return String(n).padStart(2, '0');
    };
    return (
      d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    );
  }

  /** 距今天数的中性描述，用于告诉用户数据有多新，而不是报警 */
  function relativeDay(iso) {
    var d = daysBetween(iso, todayISO());
    if (d === null) return '';
    if (d <= 0) return '（今天）';
    if (d === 1) return '（昨天）';
    return '（' + d + ' 天前）';
  }

  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function daysBetween(a, b) {
    var ta = Date.parse(a + 'T00:00:00Z');
    var tb = Date.parse(b + 'T00:00:00Z');
    if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
    return Math.round((tb - ta) / 86400000);
  }

  // ------------------------------------------------------------ 数据装载

  function boot() {
    var embedded = window.__PA_DATA__ || null;
    state.byDate = Object.assign({}, (embedded && embedded.byDate) || {});
    state.meta = (embedded && embedded.meta) || null;
    state.archive = (embedded && embedded.archive) || [];
    state.date = (embedded && embedded.latestDate) || null;
    state.daily = state.date ? state.byDate[state.date] || null : null;

    var overHttp = location.protocol === 'http:' || location.protocol === 'https:';
    // ?mode=embedded 可强制使用内嵌数据，用于验证「双击打开」时的渲染路径
    var forceEmbedded = false;
    try {
      forceEmbedded = new URLSearchParams(location.search).get('mode') === 'embedded';
    } catch (err) {
      forceEmbedded = false;
    }
    // 先用 data/daily.js 里的内嵌数据立即渲染，避免网络慢时首屏空白；
    // 在线打开时再后台拉取 data/*.json，拿到后覆盖为最新的每日数据。
    finishBoot();

    if (overHttp && !forceEmbedded) hydrateFromServer();
  }

  function hydrateFromServer() {
    Promise.all([
      fetchJson('data/meta.json').catch(function () {
        return null;
      }),
      fetchJson('data/archive.json').catch(function () {
        return null;
      }),
    ])
      .then(function (results) {
        var liveMeta = results[0];
        var liveArchive = results[1];
        var changed = false;
        if (liveMeta) {
          state.meta = liveMeta;
          changed = true;
        }
        if (liveArchive) {
          state.archive = liveArchive;
          changed = true;
        }
        state.liveMode = true;

        var latest = (liveMeta && liveMeta.lastRunDate) || state.date;
        if (!latest) {
          if (changed) render();
          return null;
        }
        return fetchJson('data/daily/' + latest + '.json')
          .then(
            function (daily) {
              state.byDate[daily.date] = daily;
              // 用户如果已经手动切到某个历史日期，就不要把他拽回最新一天
              if (!state.pinnedDate) {
                state.date = daily.date;
                state.daily = daily;
              }
              changed = true;
            },
            function () {
              return null;
            },
          )
          .then(function () {
            if (changed) render();
          });
      })
      .catch(function () {
        return null;
      });
  }

  function finishBoot() {
    if (!state.date && state.archive.length) state.date = state.archive[0].date;
    if (!state.daily && state.date) state.daily = state.byDate[state.date] || null;
    render();

    var hash = (location.hash || '').replace('#', '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(hash) && hash !== state.date) loadDate(hash);
  }

  function loadDate(date) {
    if (!date) return;
    state.pinnedDate = true;
    if (state.byDate[date]) {
      state.date = date;
      state.daily = state.byDate[date];
      state.tags.clear();
      render();
      return;
    }
    if (state.liveMode) {
      state.date = date;
      state.daily = null;
      state.tags.clear();
      render();
      fetchJson('data/daily/' + date + '.json')
        .then(function (daily) {
          state.byDate[date] = daily;
          if (state.date === date) {
            state.daily = daily;
            render();
          }
        })
        .catch(function () {
          render();
        });
      return;
    }
    state.date = date;
    state.daily = null;
    state.tags.clear();
    render();
  }

  // ------------------------------------------------------------ 渲染

  function render() {
    renderHeaderStatus();
    renderAlerts();
    renderControls();
    renderOverview();
    renderTopics();
    renderAllEntries();
    renderSources();
    renderArchive();
    renderFooter();
  }

  function renderHeaderStatus() {
    var box = $('header-status');
    var daily = state.daily;
    var meta = state.meta;
    var pills = [];

    if (daily) {
      pills.push(
        '<span class="status-pill ok">数据日期 ' +
          esc(daily.date) +
          esc(relativeDay(daily.date)) +
          '</span>',
      );
    } else {
      pills.push('<span class="status-pill bad">暂无数据</span>');
    }

    if (meta && meta.lastRunAt) {
      var okCount = meta.stats ? meta.stats.sourcesOk : null;
      var total = meta.stats ? meta.stats.sourcesTotal : null;
      pills.push('<span class="status-pill">更新于 ' + esc(fmtDateTime(meta.lastRunAt)) + '</span>');
      if (total) {
        pills.push(
          '<span class="status-pill ' +
            (okCount === total ? 'ok' : 'warn') +
            '">数据源 ' +
            esc(String(okCount)) +
            '/' +
            esc(String(total)) +
            '</span>',
        );
      }
    }
    box.innerHTML = pills.join('');
  }

  function renderAlerts() {
    var box = $('alert-area');
    var html = '';
    var meta = state.meta;
    var today = todayISO();

    if (!state.daily) {
      html +=
        '<div class="alert danger">还没有可展示的数据。请在项目目录下执行 <code>node scripts/fetch.mjs</code>' +
        '（需要联网）生成首份数据，然后刷新本页；也可以用 <code>node scripts/serve.mjs</code> 启动本地服务后访问 ' +
        '<code>http://localhost:5173</code>。</div>';
    }

    if (meta && meta.lastRunOk === false) {
      var failed = meta.failedSources;
      if (!failed && meta.sourceStatus) {
        failed = meta.sourceStatus
          .filter(function (s) {
            return !s.ok;
          })
          .map(function (s) {
            return s.name;
          });
      }
      if (failed && failed.length) {
        var all = !meta.stats || meta.stats.sourcesOk === 0;
        html +=
          '<div class="alert danger">最近一次抓取' +
          (all ? '完全失败' : '未完全成功') +
          '：' +
          esc(String(failed.length)) +
          ' 个数据源失败（' +
          esc(failed.slice(0, 6).join('、')) +
          (failed.length > 6 ? ' 等' : '') +
          '）。' +
          (all
            ? '当前展示的是上一次成功抓取的数据，请检查网络后执行 <code>node scripts/fetch.mjs</code> 重试。'
            : '其余来源数据正常，可稍后重试。') +
          '</div>';
      }
    }

    box.innerHTML = html;
  }

  function renderControls() {
    var daily = state.daily;
    var counts = { journal: 0, cnjournal: 0, news: 0, policy: 0 };
    var tagCounts = {};

    var dates = [];
    if (state.date) dates.push(state.date);
    (state.archive || []).forEach(function (item) {
      if (dates.indexOf(item.date) === -1) dates.push(item.date);
    });
    $('date-chips').innerHTML = dates
      .slice(0, 8)
      .map(function (date, index) {
        var active = date === state.date ? ' active' : '';
        return (
          '<button type="button" class="chip' +
          active +
          '" data-date="' +
          esc(date) +
          '">' +
          esc(index === 0 ? '最新 ' + date : date) +
          '</button>'
        );
      })
      .join('');

    if (daily) {
      (daily.entries || []).forEach(function (e) {
        counts[e.sourceType] = (counts[e.sourceType] || 0) + 1;
        (e.tagIds || []).forEach(function (id) {
          tagCounts[id] = (tagCounts[id] || 0) + 1;
        });
      });
    }

    $('type-chips').innerHTML = ALL_TYPES.map(function (type) {
      var active = state.types.has(type) ? ' active' : '';
      return (
        '<button type="button" class="chip' +
        active +
        '" data-type="' +
        esc(type) +
        '">' +
        esc(TYPE_LABELS[type]) +
        '<span class="chip-count">' +
        esc(String(counts[type] || 0)) +
        '</span></button>'
      );
    }).join('');

    var topics = (daily && daily.topics) || [];
    if (!topics.length) {
      $('tag-chips').innerHTML = '<span class="empty">暂无可用的议题标签</span>';
    } else {
      $('tag-chips').innerHTML = topics
        .map(function (t) {
          var active = state.tags.has(t.id) ? ' active' : '';
          return (
            '<button type="button" class="chip' +
            active +
            '" data-tag="' +
            esc(t.id) +
            '">' +
            esc(t.label) +
            '<span class="chip-count">' +
            esc(String(t.entryCount || tagCounts[t.id] || 0)) +
            '</span></button>'
          );
        })
        .join('');
    }
  }

  function renderOverview() {
    var box = $('overview');
    var daily = state.daily;
    if (!daily) {
      box.innerHTML = '<p class="empty">等待数据。</p>';
      return;
    }
    var stats = daily.stats || {};
    var windows = daily.windows || {};
    var windowText =
      windows.cnki && windows.cnki !== windows.international
        ? '统计窗口：国际顶刊近 ' +
          esc(String(windows.international || daily.windowDays || 7)) +
          ' 天 · 中文顶刊近 ' +
          esc(String(windows.cnki)) +
          ' 天'
        : '统计窗口：近 ' + esc(String(daily.windowDays || 7)) + ' 天';
    box.innerHTML =
      '<div><p class="overview-title">' +
      esc(fmtDate(daily.date)) +
      ' · ' +
      esc(String((daily.topics || []).length)) +
      ' 个议题</p><p class="overview-sub">' +
      windowText +
      ' · 生成于 ' +
      esc(fmtDateTime(daily.generatedAt)) +
      '</p></div>' +
      '<div class="stat-row">' +
      stat(stats.entries, '条文献/动态') +
      stat(stats.journals, '本顶刊有更新') +
      stat(stats.sourcesOk, '个来源正常') +
      '</div>';
  }

  function stat(value, label) {
    return (
      '<div class="stat"><b>' + esc(String(value == null ? '—' : value)) + '</b><span>' + esc(label) + '</span></div>'
    );
  }

  function typePass(entry) {
    return state.types.has(entry.sourceType);
  }

  function tagPass(entry) {
    if (!state.tags.size) return true;
    return (entry.tagIds || []).some(function (id) {
      return state.tags.has(id);
    });
  }

  function renderTopics() {
    var daily = state.daily;
    var list = $('topic-list');
    var sub = $('today-sub');
    var heading = $('today-heading');

    if (!daily || !(daily.topics || []).length) {
      heading.textContent = '今日议题';
      sub.textContent = '';
      list.innerHTML = '<div class="panel empty">暂无议题数据。</div>';
      return;
    }

    var topics = daily.topics;
    var visible = state.tags.size
      ? topics.filter(function (t) {
          return state.tags.has(t.id);
        })
      : topics;

    heading.textContent = state.tags.size
      ? '筛选后的议题'
      : daily.date === todayISO()
        ? '今日议题'
        : '最新议题';
    sub.textContent =
      (state.tags.size ? '已选 ' + state.tags.size + ' 个标签 · ' : '') +
      '每个议题下方「拓展板块」给出未来可做的选题方向。';

    if (!visible.length) {
      list.innerHTML = '<div class="panel empty">当前标签筛选下没有议题，试试清除标签筛选。</div>';
      return;
    }

    var maxScore = Math.max.apply(
      null,
      topics.map(function (t) {
        return t.hotScore || 0;
      }).concat([0.001]),
    );

    list.innerHTML = visible
      .map(function (topic, index) {
        return renderTopicCard(topic, index, maxScore);
      })
      .join('');
  }

  function renderTopicCard(topic, index, maxScore) {
    var pct = Math.max(8, Math.round(((topic.hotScore || 0) / maxScore) * 100));
    var badge = topic.kind === '最新' ? 'badge-fresh' : 'badge-hot';
    var entries = (topic.entries || []).filter(typePass);

    var outletChips = (topic.outlets || [])
      .map(function (o) {
        return '<span class="outlet-chip">' + esc(o.name) + ' × ' + esc(String(o.count)) + '</span>';
      })
      .join('');

    var entryHtml = entries.length
      ? '<ul class="entry-list">' + entries.map(renderEntry).join('') + '</ul>'
      : '<p class="empty">当前来源筛选下该议题没有可展示条目。</p>';

    var ideas = (topic.ideas || [])
      .map(function (idea) {
        return (
          '<li class="idea"><h4>' +
          esc(idea.title) +
          '</h4><dl>' +
          '<dt>理论视角</dt><dd>' +
          esc(idea.theory) +
          '</dd>' +
          '<dt>研究方法</dt><dd>' +
          esc(idea.method) +
          '</dd>' +
          '<dt>数据与案例</dt><dd>' +
          esc(idea.data) +
          '</dd>' +
          '</dl></li>'
        );
      })
      .join('');

    return (
      '<article class="topic-card">' +
      '<div class="topic-head">' +
      '<div class="topic-index">' +
      esc(String(index + 1).padStart(2, '0')) +
      '</div>' +
      '<div class="topic-title-wrap">' +
      '<h3 class="topic-title">' +
      esc(topic.label) +
      '<span class="badge ' +
      badge +
      '">' +
      esc(topic.kind) +
      '</span></h3>' +
      '<p class="topic-summary">' +
      esc(topic.summary || '') +
      '</p>' +
      '</div>' +
      '</div>' +
      '<div class="heatbar"><span style="width:' +
      pct +
      '%"></span></div>' +
      '<div class="outlet-chips">' +
      outletChips +
      '</div>' +
      '<p class="block-title">代表文献 / 动态（' +
      esc(String(entries.length)) +
      '）</p>' +
      entryHtml +
      '<details class="extension"><summary>拓展板块 · 未来可做的选题方向（' +
      esc(String((topic.ideas || []).length)) +
      '）</summary><ol class="idea-list">' +
      ideas +
      '</ol></details>' +
      '</article>'
    );
  }

  function renderEntry(entry) {
    var meta = [];
    if (entry.outletZh || entry.outlet) meta.push('<span class="entry-outlet">' + esc(entry.outletZh || entry.outlet) + '</span>');
    if (entry.publishedAt)
      meta.push(
        '<span>' +
          esc(entry.publishedAt) +
          (entry.datePrecision === 'month' ? '（按期）' : entry.datePrecision === 'year' ? '（按年）' : '') +
          '</span>',
      );
    if (entry.docNumber) meta.push('<span>' + esc(entry.docNumber) + '</span>');
    if (entry.org) meta.push('<span>' + esc(entry.org) + '</span>');
    meta.push('<span>' + esc(TYPE_LABELS[entry.sourceType] || entry.sourceType) + '</span>');

    var sub = [];
    if (entry.authors && entry.authors.length) {
      var authors = entry.authors.slice(0, 4).join('、');
      if (entry.authors.length > 4) authors += ' 等';
      sub.push(esc(authors));
    }

    var tagList = (entry.tags || []).slice(0, 4);
    var tags = tagList.length
      ? tagList
          .map(function (t) {
            return '<span class="mini-tag">' + esc(t) + '</span>';
          })
          .join('')
      : '<span class="mini-tag muted-tag">未匹配议题标签</span>';

    var titleHtml = entry.url
      ? '<a class="entry-title" href="' +
        esc(entry.url) +
        '" target="_blank" rel="noopener noreferrer">' +
        esc(entry.title) +
        '</a>'
      : '<span class="entry-title">' + esc(entry.title) + '</span>';

    var abstract = entry.abstract
      ? '<details><summary>查看摘要</summary><p>' + esc(entry.abstract) + '</p></details>'
      : '';

    return (
      '<li class="entry type-' +
      esc(entry.sourceType) +
      '">' +
      '<div class="entry-meta">' +
      meta.join('') +
      '</div>' +
      titleHtml +
      (sub.length ? '<div class="entry-sub">' + sub.join(' · ') + '</div>' : '') +
      (tags ? '<div class="entry-tags">' + tags + '</div>' : '') +
      abstract +
      '</li>'
    );
  }

  function renderAllEntries() {
    var daily = state.daily;
    var box = $('entries-list');
    var text = $('entries-summary-text');

    if (!daily) {
      text.textContent = '当日全部条目';
      box.innerHTML = '<p class="empty">暂无数据。</p>';
      return;
    }

    var all = (daily.entries || []).filter(function (e) {
      return typePass(e) && tagPass(e);
    });
    text.textContent =
      '当日全部条目（' + all.length + ' / ' + (daily.entries || []).length + '）· 按发布日期排序';

    if (!all.length) {
      box.innerHTML = '<p class="empty">当前筛选下没有条目。</p>';
      return;
    }

    box.innerHTML = all
      .slice(0, 120)
      .map(renderEntry)
      .join('');
  }

  function renderSources() {
    var box = $('sources-body');
    var meta = state.meta;
    if (!meta || !meta.sourceStatus || !meta.sourceStatus.length) {
      box.innerHTML =
        '<p class="empty">还没有抓取记录。执行 <code>node scripts/fetch.mjs</code> 后会显示每个数据源的状态。</p>';
      return;
    }
    var rows = meta.sourceStatus
      .map(function (s) {
        var status = s.ok
          ? '<span class="dot ok"></span>正常'
          : '<span class="dot bad"></span>失败';
        var note = s.ok
          ? esc(String(s.count)) + ' 条'
          : '<span title="' + esc(s.error || '') + '">' + esc(s.error || '未知错误') + '</span>';
        return (
          '<tr><td>' +
          esc(s.name) +
          '</td><td>' +
          esc(TYPE_LABELS[s.type] || s.type || '—') +
          '</td><td>' +
          status +
          '</td><td>' +
          note +
          '</td><td>' +
          esc(s.ms == null ? '—' : String(s.ms) + ' ms') +
          '</td></tr>'
        );
      })
      .join('');
    box.innerHTML =
      '<p class="section-sub">最近一次运行：' +
      esc(fmtDateTime(meta.lastRunAt)) +
      '，共 ' +
      esc(String(meta.sourceStatus.length)) +
      ' 个来源。</p>' +
      '<table><thead><tr><th>数据源</th><th>类型</th><th>状态</th><th>结果</th><th>耗时</th></tr></thead><tbody>' +
      rows +
      '</tbody></table>';
  }

  function renderArchive() {
    var box = $('archive-list');
    var sub = $('archive-sub');
    var archive = state.archive || [];

    if (!archive.length) {
      sub.textContent = '暂无历史数据。';
      box.innerHTML = '';
      return;
    }

    var embeddedDates = Object.keys(state.byDate);
    sub.textContent = state.liveMode
      ? '共 ' + archive.length + ' 天记录，点击切换查看往期议题。'
      : '双击模式下仅内嵌 ' + embeddedDates.length + ' 天数据；运行 ' + 'node scripts/serve.mjs' + ' 可查看完整历史。';

    box.innerHTML = archive
      .slice(0, 40)
      .map(function (item) {
        var active = item.date === state.date ? ' active' : '';
        var flag = item.ok === false ? '（部分失败）' : '';
        return (
          '<button type="button" class="chip' +
          active +
          '" data-date="' +
          esc(item.date) +
          '">' +
          esc(fmtShort(item.date)) +
          flag +
          '<span class="chip-count">' +
          esc(String(item.entryCount || 0)) +
          '</span></button>'
        );
      })
      .join('');
  }

  function renderFooter() {
    var daily = state.daily;
    var parts = ['数据日期：' + (daily ? daily.date : '—')];
    if (state.meta && state.meta.lastRunAt) parts.push('最近抓取：' + fmtDateTime(state.meta.lastRunAt));
    parts.push('加载方式：' + (state.liveMode ? '在线读取 data/' : '内嵌数据（离线打开）'));
    $('footer-meta').textContent = parts.join(' · ');
  }

  // ------------------------------------------------------------ 事件绑定

  document.addEventListener('click', function (event) {
    var target = event.target.closest('[data-type],[data-tag],[data-date]');
    if (!target) return;

    if (target.dataset.type) {
      var type = target.dataset.type;
      if (state.types.has(type)) {
        if (state.types.size === 1) return;
        state.types.delete(type);
      } else {
        state.types.add(type);
      }
      render();
      return;
    }

    if (target.dataset.tag) {
      var tag = target.dataset.tag;
      if (state.tags.has(tag)) state.tags.delete(tag);
      else state.tags.add(tag);
      render();
      return;
    }

    if (target.dataset.date) loadDate(target.dataset.date);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
