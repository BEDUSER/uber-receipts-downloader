// ==UserScript==
// @name         Uber 收据批量下载（按日期范围 / PDF）
// @namespace    https://github.com/BEDUSER/uber-receipts-downloader
// @version      1.0.2
// @description  在 riders.uber.com/trips 注入面板，按日期范围一键批量下载行程收据 PDF（Invoice 优先，Receipt 兜底）。带随机真人延迟、分批暂停、失败重试、风控自动停、进度与结果 CSV。纯读取，不修改账户任何数据。
// @author       BEDUSER
// @license      MIT
// @homepageURL  https://github.com/BEDUSER/uber-receipts-downloader
// @supportURL   https://github.com/BEDUSER/uber-receipts-downloader/issues
// @downloadURL  https://raw.githubusercontent.com/BEDUSER/uber-receipts-downloader/main/uber_receipts_batch.user.js
// @updateURL    https://raw.githubusercontent.com/BEDUSER/uber-receipts-downloader/main/uber_receipts_batch.user.js
// @match        https://riders.uber.com/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      riders.uber.com
// @connect      tbgs-static.uber.com
// @connect      *.uber.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * ============================================================
 *  使用说明（先读这一段）
 * ============================================================
 * 1) 打开 https://riders.uber.com/trips 并确认已登录，页面右上角会出现面板。
 * 2) 选好开始/结束日期 → 点「预览」确认能扫到行程 → 点「批量下载」。
 * 3) 全程串行，单次下载之间有 3~5 秒随机延迟；每 10 笔会额外长休息 20~35 秒。
 *    这是防风控的关键，请不要把 CFG 里的延迟改成 0。
 * 4) 浏览器首次批量下载会弹「是否允许本站下载多个文件」→ 选「允许」。
 * 5) 结束后面板底部给出 成功/失败/跳过 统计，并可导出结果 CSV（含失败原因，
 *    失败项可再点「重试失败项」）。
 *
 * 想按你实际页面结构微调的话，重点看这几处：
 *   - CFG                : 全部延迟/重试/开关
 *   - GQL                : Uber 内部 GraphQL 查询（拿行程列表 + 收据 PDF 地址）
 *   - findLoadMore()     : 「显示更多」按钮的识别（多语言 + data-testid）
 *   - pickReceiptTrigger : 行程卡片上「查看收据」入口的识别
 *   - detectPdfAnchor()  : 收据弹窗里「下载 PDF」链接的识别
 * ============================================================
 *  分享 / 发布
 * ============================================================
 * 本文件已内置自动更新地址（指向 BEDUSER/uber-receipts-downloader 的 main 分支）：
 *
 *   安装链接：https://raw.githubusercontent.com/BEDUSER/uber-receipts-downloader/main/uber_receipts_batch.user.js
 *
 * 以后发新版只要：改这里的 @version（往上加）→ 提交推送，
 * 已安装的用户会在 24 小时内自动更新，无需重新安装。
 * 若把仓库改名/迁移，记得同步修改上面 @downloadURL / @updateURL 两行。
 * ============================================================
 */

(function () {
  'use strict';

  /* =========================================================
   * 1. 配置
   * =======================================================*/
  const CFG = {
    // —— 频率控制（防封号，别乱调）——
    delayMinMs: 3000,          // 两次下载之间的最小间隔
    delayMaxMs: 5000,          // 最大间隔（实际取区间内随机值）
    longPauseEvery: 10,        // 每下载 N 笔后长休息一次
    longPauseMinMs: 20000,
    longPauseMaxMs: 35000,
    reqDelayMs: 400,           // 行程列表/收据接口之间的间隔
    pageSize: 20,              // 行程列表每页条数

    // —— 容错 ——
    maxRetry: 2,               // 单笔失败重试次数
    consecutiveFailLimit: 4,   // 连续失败多少笔就自动停（防止被风控还硬刷）
    cooldownAfterRiskMs: 60000,// 触发 429/403 后的冷却时间
    maxTripCount: 0,           // 0 = 不限制；调试时可设 10

    // —— 下载方式 ——
    useGM_download: true,      // true=GM_download(blob) 优先，失败自动回退 <a download>
    saveAs: false,             // 是否每笔都弹「另存为」

    // —— 数据来源 ——
    apiFirst: true,            // 优先用 GraphQL（快、准、天然支持时间过滤）；失败回退 DOM 滚动
    skipCanceledTrips: false,  // true=跳过已取消/未完成行程；默认 false（取消行程有时也有取消费收据）
    debug: false,
  };

  // 已取消 / 未完成 的行程（多语言关键词，注意大小写不敏感）
  const SKIP_RE = /cancel|unfulfilled|已取消|未完成|取消済|cancelad[oa]|anulad/i;
  // 「显示更多 / 加载更多」多语言
  const MORE_RE = /show\s*more|load\s*more|see\s*more|more\s*trips|mostrar\s*mais|carregar\s*mais|ver\s*m[áa]s|cargar\s*m[áa]s|afficher\s*plus|charger\s*plus|mehr\s*anzeigen|mehr\s*laden|显示更多|加载更多|さらに表示|더\s*보기/i;
  // 「收据」多语言（仅作兜底，优先 data-testid / href）
  const RECEIPT_RE = /receipt|recibo|comprobante|factura|nota\s*fiscal|收据|发票|領収書|quittung|reçu|ricevuta/i;
  // 「下载」多语言
  const DOWNLOAD_RE = /download|baixar|descargar|télécharger|herunterladen|下载|ダウンロード/i;

  const PANEL_ID = 'uber-rc-panel';

  /* =========================================================
   * 2. Uber 内部 GraphQL（实测可用的三个查询）
   *    这些是网页版自己用的接口；只读，不会改任何数据。
   * =======================================================*/
  const GQL = {
    // 行程列表：天然支持 startTimeMs / endTimeMs 时间过滤 + nextPageToken 翻页，
    // 所以「自动加载更多」在 API 模式下就是翻页，比滚动 DOM 稳得多。
    Activities: {
      document: `query Activities($cityID: Int, $endTimeMs: Float, $includePast: Boolean = true, $includeUpcoming: Boolean = true, $limit: Int = 5, $nextPageToken: String, $orderTypes: [RVWebCommonActivityOrderType!] = [RIDES, TRAVEL], $profileType: RVWebCommonActivityProfileType = PERSONAL, $startTimeMs: Float) {
  activities(cityID: $cityID) {
    cityID
    past(endTimeMs: $endTimeMs, limit: $limit, nextPageToken: $nextPageToken, orderTypes: $orderTypes, profileType: $profileType, startTimeMs: $startTimeMs) @include(if: $includePast) {
      activities { cardURL description subtitle title uuid __typename }
      nextPageToken
      __typename
    }
    __typename
  }
}`,
    },
    // 部分地区（如巴西/拉美）有正式 invoice（发票）PDF，优先用它，报销更正规
    GetInvoiceFiles: {
      document: `query GetInvoiceFiles($tripUUID: ID!) {
  invoiceFiles(tripUUID: $tripUUID) {
    archiveURL
    files { downloadURL __typename }
    __typename
  }
}`,
    },
    // 通用兜底：拿到该行程的收据 timestamp，再拼 PDF 地址
    GetReceipt: {
      document: `query GetReceipt($tripUUID: String!, $timestamp: String) {
  getReceipt(tripUUID: $tripUUID, timestamp: $timestamp) {
    actionList { type __typename }
    receiptsForJob { timestamp type eventUUID __typename }
    __typename
  }
}`,
    },
  };

  /* =========================================================
   * 3. 小工具
   * =======================================================*/
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
  const delayBetweenDownloads = () => sleep(rand(CFG.delayMinMs, CFG.delayMaxMs));

  class RiskError extends Error {}   // 429 / 403 / 402：疑似风控
  class StopError extends Error {}   // 用户点了停止

  function debug(...args) {
    if (CFG.debug) console.log('[UberRC]', ...args);
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  }

  // 轮询等待元素出现（DOM 兜底路径用）
  function waitFor(predicate, timeout = 8000, interval = 200) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeout;
      (function check() {
        let el = null;
        try { el = predicate(); } catch (_) { /* 选择器写错也不能把整个流程炸掉 */ }
        if (el) return resolve(el);
        if (Date.now() > deadline) return reject(new Error('waitFor timeout'));
        setTimeout(check, interval);
      })();
    });
  }

  // 从各种 URL 里抠出 trip uuid（/trips/<uuid>、jobId=<uuid>、cardURL 等）
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  function extractUuid(input) {
    if (!input) return null;
    const s = String(input);
    let m = s.match(UUID_RE);
    if (m) return m[0];
    // 有些 cardURL 用非标准 id（纯 22~36 位字母数字）
    m = s.match(/\/trips\/([\w-]{10,40})/);
    return m ? m[1] : null;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

  // <input type="date"> 的 YYYY-MM-DD 按【本地时区】解释，避免时区导致差一天
  function dayStartMs(value) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  }
  function dayEndMs(value) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
  }
  function msToDate(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return `${fmtDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  // 文件名里不能出现的字符
  function safeName(s) {
    return String(s || '').replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  /* =========================================================
   * 4. UI
   * =======================================================*/
  const state = {
    running: false,
    stopRequested: false,
    results: [],        // { uuid, label, date, kind, filename, status, message }
  };

  const ui = {};

  const CSS = `
  #${PANEL_ID}{position:fixed;top:12px;right:12px;z-index:2147483000;width:344px;
    background:#0b0b0b;color:#e8e8e8;border:1px solid #2c2c2c;border-radius:14px;
    box-shadow:0 12px 40px rgba(0,0,0,.55);font:13px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;
    overflow:hidden;user-select:none}
  #${PANEL_ID} .hd{display:flex;align-items:center;justify-content:space-between;gap:8px;
    padding:10px 12px;background:linear-gradient(180deg,#151515,#101010);cursor:default}
  #${PANEL_ID} .hd b{font-size:13px;letter-spacing:.2px}
  #${PANEL_ID} .hd .dot{width:8px;height:8px;border-radius:50%;background:#06c167;display:inline-block;margin-right:6px;vertical-align:1px}
  #${PANEL_ID} .hd button{background:transparent;border:0;color:#9a9a9a;font-size:15px;cursor:pointer;padding:0 2px}
  #${PANEL_ID} .hd button:hover{color:#fff}
  #${PANEL_ID} .bd{padding:12px;display:block}
  #${PANEL_ID}.collapsed .bd{display:none}
  #${PANEL_ID} .row{display:flex;align-items:center;gap:8px;margin-bottom:9px}
  #${PANEL_ID} label{color:#9a9a9a;font-size:12px;min-width:52px}
  #${PANEL_ID} input[type=date]{flex:1;min-width:0;background:#1b1b1b;border:1px solid #333;color:#eee;
    border-radius:8px;padding:6px 8px;font:12px/1.4 system-ui,sans-serif;color-scheme:dark}
  #${PANEL_ID} input[type=date]:focus{outline:none;border-color:#06c167}
  #${PANEL_ID} .presets{display:flex;gap:6px;margin:0 0 10px 60px;flex-wrap:wrap}
  #${PANEL_ID} .presets button{background:#1b1b1b;border:1px solid #333;color:#bbb;border-radius:999px;
    padding:3px 10px;font-size:11px;cursor:pointer}
  #${PANEL_ID} .presets button:hover{border-color:#06c167;color:#06c167}
  #${PANEL_ID} .actions{display:flex;gap:8px;margin-top:4px}
  #${PANEL_ID} .actions button{flex:1;border:0;border-radius:9px;padding:9px 10px;font-weight:700;font-size:13px;cursor:pointer}
  #${PANEL_ID} .primary{background:#06c167;color:#062b17}
  #${PANEL_ID} .primary:hover{background:#05ab5b}
  #${PANEL_ID} .primary:disabled{background:#26402f;color:#5f7a6a;cursor:not-allowed}
  #${PANEL_ID} .ghost{background:#1b1b1b;color:#ddd;border:1px solid #333 !important;font-weight:600}
  #${PANEL_ID} .ghost:hover{border-color:#06c167 !important;color:#06c167}
  #${PANEL_ID} .ghost:disabled{color:#555;border-color:#262626 !important;cursor:not-allowed}
  #${PANEL_ID} .stop{background:#3a1414;color:#ff8b8b;border:1px solid #5a1d1d !important}
  #${PANEL_ID} .progress{margin-top:10px;padding:8px 10px;background:#141414;border:1px solid #262626;
    border-radius:9px;font-size:12px;color:#f0f0f0;white-space:pre-wrap;word-break:break-word}
  #${PANEL_ID} .bar{height:4px;background:#232323;border-radius:99px;overflow:hidden;margin-top:6px}
  #${PANEL_ID} .bar > i{display:block;height:100%;width:0;background:#06c167;transition:width .25s}
  #${PANEL_ID} .log{margin-top:8px;max-height:110px;overflow:auto;font-size:11px;line-height:1.6;
    color:#8f8f8f;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap}
  #${PANEL_ID} .log .err{color:#ff8686}
  #${PANEL_ID} .log .ok{color:#5fd08a}
  #${PANEL_ID} .log .warn{color:#f0c05a}
  #${PANEL_ID} .tip{margin-top:8px;font-size:11px;color:#6d6d6d;line-height:1.5}
  #${PANEL_ID} .hint{color:#f0c05a}
  `;

  function mountPanel() {
    if (document.getElementById(PANEL_ID)) return true;

    const host = document.body || document.documentElement;
    if (!host) return false;

    const style = document.createElement('style');
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="hd">
        <b><span class="dot"></span>Uber 收据批量下载</b>
        <button type="button" data-act="collapse" title="折叠">—</button>
      </div>
      <div class="bd">
        <div class="row"><label>开始</label><input type="date" data-role="start"></div>
        <div class="row"><label>结束</label><input type="date" data-role="end"></div>
        <div class="presets">
          <button type="button" data-preset="30">近30天</button>
          <button type="button" data-preset="90">近3个月</button>
          <button type="button" data-preset="ytd">今年</button>
          <button type="button" data-preset="365">近1年</button>
        </div>
        <div class="actions">
          <button type="button" class="ghost" data-act="preview">预览</button>
          <button type="button" class="primary" data-act="run">批量下载</button>
        </div>
        <div class="actions" style="margin-top:8px">
          <button type="button" class="ghost" data-act="retry">重试失败项</button>
          <button type="button" class="ghost" data-act="csv">导出结果CSV</button>
        </div>
        <div class="progress" data-role="progress">就绪。选好日期后先点「预览」。</div>
        <div class="bar"><i data-role="bar"></i></div>
        <div class="log" data-role="log"></div>
        <div class="tip">串行下载，每次间隔 3~5 秒，每 10 笔长休息。<br>
        首次会提示「允许下载多个文件」，请选择允许。<br>
        请保持本标签页在前台，不要关页面。</div>
      </div>`;
    host.appendChild(panel);

    ui.panel = panel;
    ui.start = panel.querySelector('[data-role="start"]');
    ui.end = panel.querySelector('[data-role="end"]');
    ui.progress = panel.querySelector('[data-role="progress"]');
    ui.bar = panel.querySelector('[data-role="bar"]');
    ui.log = panel.querySelector('[data-role="log"]');
    ui.btnRun = panel.querySelector('[data-act="run"]');
    ui.btnPreview = panel.querySelector('[data-act="preview"]');
    ui.btnRetry = panel.querySelector('[data-act="retry"]');
    ui.btnCsv = panel.querySelector('[data-act="csv"]');
    ui.btnStop = null;

    // 默认区间：最近 90 天
    const today = new Date();
    const from = new Date(today.getTime() - 89 * 86400000);
    ui.start.value = fmtDate(from);
    ui.end.value = fmtDate(today);

    panel.addEventListener('click', onPanelClick);
    return true;
  }

  function onPanelClick(ev) {
    const btn = ev.target.closest('button');
    if (!btn) return;

    if (btn.dataset.act === 'collapse') {
      ui.panel.classList.toggle('collapsed');
      btn.textContent = ui.panel.classList.contains('collapsed') ? '+' : '—';
      return;
    }
    if (btn.dataset.preset) {
      applyPreset(btn.dataset.preset);
      return;
    }
    if (btn.dataset.act === 'run') {
      if (state.running) return;
      runBatch({ mode: 'download' });
      return;
    }
    if (btn.dataset.act === 'preview') {
      if (state.running) return;
      runBatch({ mode: 'preview' });
      return;
    }
    if (btn.dataset.act === 'retry') {
      if (state.running) return;
      retryFailed();
      return;
    }
    if (btn.dataset.act === 'csv') {
      exportCsv();
      return;
    }
    if (btn.dataset.act === 'stop') {
      state.stopRequested = true;
      setProgress('正在安全停止…（当前这笔会做完）');
    }
  }

  function applyPreset(kind) {
    const today = new Date();
    let start = new Date(today);
    if (kind === 'ytd') {
      start = new Date(today.getFullYear(), 0, 1);
    } else {
      start = new Date(today.getTime() - (Number(kind) - 1) * 86400000);
    }
    ui.start.value = fmtDate(start);
    ui.end.value = fmtDate(today);
  }

  function setProgress(text) {
    if (ui.progress) ui.progress.textContent = text;
  }

  function setBar(done, total) {
    if (!ui.bar) return;
    ui.bar.style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : '0';
  }

  function logLine(text, cls) {
    if (!ui.log) return;
    const line = document.createElement('div');
    if (cls) line.className = cls;
    const t = new Date();
    line.textContent = `[${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}] ${text}`;
    ui.log.appendChild(line);
    ui.log.scrollTop = ui.log.scrollHeight;
    debug(text);
  }

  function setRunning(on, canStop) {
    state.running = on;
    if (ui.btnRun) ui.btnRun.disabled = on;
    if (ui.btnPreview) ui.btnPreview.disabled = on;
    if (ui.btnRetry) ui.btnRetry.disabled = on;

    if (on && canStop && !ui.btnStop && ui.panel) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'stop';
      b.dataset.act = 'stop';
      b.textContent = '停止';
      b.style.cssText = 'margin-top:8px;width:100%;border-radius:9px;padding:7px;font-size:12px;cursor:pointer';
      ui.progress.after(b);
      ui.btnStop = b;
    }
    if (!on && ui.btnStop) {
      ui.btnStop.remove();
      ui.btnStop = null;
    }
  }

  /* =========================================================
   * 5. 数据源 A：GraphQL（首选）
   * =======================================================*/
  async function gql(name, variables) {
    const op = GQL[name];
    if (!op) throw new Error(`未知查询 ${name}`);
    const resp = await fetch('/graphql', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': 'x',
      },
      credentials: 'include',
      body: JSON.stringify({ operationName: name, variables, query: op.document }),
    });

    if (resp.status === 429 || resp.status === 403 || resp.status === 402) {
      throw new RiskError(`GraphQL ${resp.status}`);
    }
    if (resp.status === 401) {
      throw new RiskError('未登录（401），请先登录 Uber 再运行');
    }
    if (!resp.ok) throw new Error(`GraphQL HTTP ${resp.status}`);

    const json = await resp.json();
    if (json.errors && json.errors.length) {
      throw new Error(json.errors.map((e) => e.message).join('; '));
    }
    return json.data || {};
  }

  async function collectTripsFromApi(startMs, endMs) {
    const trips = [];
    const seen = new Set();
    let token = null;

    for (let page = 0; page < 500; page++) {
      const variables = {
        includePast: true,
        includeUpcoming: false,
        limit: CFG.pageSize,
        orderTypes: ['RIDES', 'TRAVEL'],
        profileType: 'PERSONAL',
      };
      if (startMs) variables.startTimeMs = startMs;
      if (endMs) variables.endTimeMs = endMs;
      if (token) variables.nextPageToken = token;

      const data = await gql('Activities', variables);
      const past = data.activities && data.activities.past;
      if (!past || !Array.isArray(past.activities)) break;

      for (const a of past.activities) {
        const uuid = extractUuid(a.uuid || a.cardURL);
        if (!uuid || seen.has(uuid)) continue;
        seen.add(uuid);
        trips.push({
          uuid,
          title: a.title || '',
          subtitle: a.subtitle || '',
          description: a.description || '',
          dateMs: null,   // 接口没给时间戳，日期过滤交给服务端
        });
      }

      setProgress(`已获取行程 ${trips.length} 条…`);
      token = past.nextPageToken;
      if (!token) break;
      if (CFG.maxTripCount && trips.length >= CFG.maxTripCount) break;
      await sleep(CFG.reqDelayMs + rand(0, 250));
    }

    return trips;
  }

  /* =========================================================
   * 6. 数据源 B：DOM 滚动兜底
   *    （接口挂了/改版时用；也用来处理「只渲染了部分卡片」的情况）
   * =======================================================*/
  function scrollTripsContainer() {
    const scrollers = [document.scrollingElement, document.documentElement, document.body];
    // Uber 行程列表可能在内部容器里滚动，找出可滚动且高度最大的容器
    document.querySelectorAll('div, main, section').forEach((el) => {
      if (!el.scrollHeight || !el.clientHeight) return;
      if (el.scrollHeight - el.clientHeight > 200) scrollers.push(el);
    });
    for (const el of scrollers) {
      if (!el) continue;
      try {
        el.scrollTop = el.scrollHeight;
      } catch (_) { /* 有些元素不可滚动 */ }
    }
    window.scrollTo(0, document.body.scrollHeight);
  }

  function findLoadMore() {
    // 1) data-testid 优先（不依赖语言，最稳）
    const byTestId = document.querySelector(
      '[data-testid*="show-more" i],[data-testid*="showMore" i],[data-testid*="load-more" i],[data-testid*="loadMore" i],[data-testid*="more-button" i],[data-testid*="pagination" i]'
    );
    if (byTestId && isVisible(byTestId)) return byTestId;

    // 2) 宽泛 XPath：任何可点击元素，文本匹配多语言关键词
    const xpath = "//button|//a|//*[@role='button']";
    try {
      const it = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < it.snapshotLength; i++) {
        const el = it.snapshotItem(i);
        const txt = (el.innerText || '').trim();
        if (txt && txt.length <= 40 && MORE_RE.test(txt) && isVisible(el)) return el;
      }
    } catch (_) { /* 某些环境禁用 XPath，忽略 */ }
    return null;
  }

  function readCardDateMs(link) {
    let node = link;
    for (let i = 0; i < 6 && node; i++) {
      const t = node.querySelector && node.querySelector('time[datetime],time,[datetime],[data-testid*="date" i]');
      if (t) {
        const raw = t.getAttribute('datetime') || t.textContent || '';
        const ms = Date.parse(raw);
        if (!isNaN(ms)) return ms;
      }
      node = node.parentElement;
    }
    return null;
  }

  async function collectTripsFromDom(startMs, endMs) {
    const found = new Map();
    let earliest = Infinity;
    let idleRounds = 0;

    const grab = () => {
      const links = document.querySelectorAll('a[href*="/trips/"],a[href*="jobId="]');
      links.forEach((a) => {
        const uuid = extractUuid(a.getAttribute('href') || '');
        if (!uuid || found.has(uuid)) return;
        const card = a.closest('li') || a.closest('[data-testid]') || a.parentElement;
        const dateMs = readCardDateMs(a);
        if (dateMs) earliest = Math.min(earliest, dateMs);
        found.set(uuid, {
          uuid,
          title: (a.innerText || '').trim() || (card && card.innerText ? card.innerText.split('\n')[0] : ''),
          subtitle: '',
          description: card && card.innerText ? card.innerText.replace(/\s+/g, ' ').slice(0, 120) : '',
          dateMs,
        });
      });
    };

    for (let round = 0; round < 80; round++) {
      grab();
      const before = found.size;

      const more = findLoadMore();
      if (more) {
        debug('点击「显示更多」');
        more.click();
      } else {
        scrollTripsContainer();
      }
      await sleep(900 + rand(0, 700));
      grab();

      setProgress(`滚动加载中：已发现 ${found.size} 条行程…`);

      if (found.size === before) idleRounds++; else idleRounds = 0;

      // 已经加载到比开始日期更早的行程了 → 没必要继续滚
      if (startMs && earliest < startMs - 3 * 86400000) break;
      if (idleRounds >= 4) break;
      if (state.stopRequested) break;
    }

    let list = [...found.values()];
    // 已知日期的按范围过滤；未知日期的保留（宁可多问一句，也不要漏单）
    list = list.filter((t) => {
      if (!t.dateMs) return true;
      if (startMs && t.dateMs < startMs) return false;
      if (endMs && t.dateMs > endMs) return false;
      return true;
    });

    window.scrollTo(0, 0);
    return list;
  }

  /* =========================================================
   * 7. 收据 PDF 地址解析
   *    顺序：invoice PDF → receipt PDF → DOM 点击兜底
   * =======================================================*/
  async function resolvePdfUrl(trip) {
    // 7.1 正式发票（部分地区有）
    try {
      const data = await gql('GetInvoiceFiles', { tripUUID: trip.uuid });
      const files = (data.invoiceFiles && data.invoiceFiles.files) || [];
      const pdf = files.find((f) => /\.pdf(\?|$)/i.test(f.downloadURL || ''));
      if (pdf) return { kind: 'invoice', url: pdf.downloadURL };
    } catch (e) {
      if (e instanceof RiskError) throw e;
      debug('invoice 查询失败:', e.message);
    }

    // 7.2 收据 PDF（把 timestamp 拼进 content-type 参数里，就是 Uber 官方 PDF）
    try {
      const data = await gql('GetReceipt', { tripUUID: trip.uuid, timestamp: '' });
      const jobs = (data.getReceipt && data.getReceipt.receiptsForJob) || [];
      const job = jobs.find((j) => j.type === 'COMPLETED') || jobs[0];
      if (job && job.timestamp) {
        return {
          kind: 'receipt',
          url: `${location.origin}/trips/${trip.uuid}/receipt?contentType=PDF&timestamp=${encodeURIComponent(job.timestamp)}`,
        };
      }
    } catch (e) {
      if (e instanceof RiskError) throw e;
      debug('receipt 查询失败:', e.message);
    }

    // 7.3 DOM 兜底：点开卡片上的「查看收据」，抓弹窗里的「下载 PDF」链接
    return resolvePdfUrlViaDom(trip);
  }

  function pickReceiptTrigger(root) {
    // data-testid 优先（Receipt / Invoice / Download 都可能是入口）
    const byTestId = root.querySelector(
      '[data-testid*="receipt" i],[data-testid*="invoice" i],[data-testid*="download" i]'
    );
    if (byTestId && isVisible(byTestId)) return byTestId;

    // 直链（href 里带 receipt / pdf）
    const direct = root.querySelector('a[href*="receipt" i],a[href*=".pdf" i],a[href*="contentType=PDF" i]');
    if (direct) return direct;

    // 文本兜底（多语言）
    for (const el of root.querySelectorAll('button,a,[role="button"],[tabindex]')) {
      const txt = (el.innerText || '').trim();
      if (txt && txt.length <= 30 && RECEIPT_RE.test(txt) && isVisible(el)) return el;
    }
    return null;
  }

  function detectPdfAnchor() {
    return document.querySelector(
      'a[href*="contentType=PDF"],a[href*=".pdf"],a[download][href*="receipt"],[data-testid*="download-pdf" i] a,[data-testid*="downloadPdf" i]'
    );
  }

  async function closeAnyModal() {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    const closeBtn = document.querySelector(
      '[data-testid*="close" i],[aria-label*="close" i],[aria-label*="fechar" i],[aria-label*="cerrar" i]'
    );
    if (closeBtn && isVisible(closeBtn)) {
      closeBtn.click();
      await sleep(400);
    }
  }

  function absolutize(href) {
    try {
      return new URL(href, location.href).toString();
    } catch (_) {
      return href;
    }
  }

  // 把收据页地址补上 PDF 参数（已有就不动）
  function withPdfParam(href) {
    try {
      const u = new URL(href, location.href);
      if (!/contenttype/i.test(u.search)) u.searchParams.set('contentType', 'PDF');
      return u.toString();
    } catch (_) {
      return href;
    }
  }

  async function resolvePdfUrlViaDom(trip) {
    const link = document.querySelector(`a[href*="${trip.uuid}"]`);
    if (!link) return null;

    const card = link.closest('li') || link.closest('[data-testid]') || link.parentElement;
    if (!card) return null;

    try { card.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) { /* 忽略 */ }
    await sleep(700);

    const trigger = pickReceiptTrigger(card);
    if (!trigger) {
      debug('卡片上找不到收据入口', trip.uuid);
      return null;
    }

    // 入口本身是链接时不要点击：一点就把整个 SPA 跳走了，脚本状态全丢。
    // 直接把 href 换成 PDF 端点（收据页 → 加 contentType=PDF；详情页 → 用收据端点）。
    const href = trigger.getAttribute('href');
    if (trigger.tagName === 'A' && href) {
      if (/receipt/i.test(href)) return { kind: 'receipt-link', url: withPdfParam(href) };
      return {
        kind: 'receipt-link',
        url: `${location.origin}/trips/${trip.uuid}/receipt?contentType=PDF`,
      };
    }

    trigger.click();
    let anchor = null;
    try {
      anchor = await waitFor(detectPdfAnchor, 9000);
    } catch (_) {
      anchor = null;
    }

    let result = null;
    if (anchor) {
      const aHref = anchor.getAttribute('href') || '';
      if (aHref) result = { kind: 'receipt-dom', url: withPdfParam(absolutize(aHref)) };
    }

    await closeAnyModal();
    return result;
  }

  /* =========================================================
   * 8. 下载
   * =======================================================*/
  function isCrossOrigin(url) {
    try {
      return new URL(url, location.href).origin !== location.origin;
    } catch (_) {
      return false;
    }
  }

  function assertPdf(buf) {
    const head = String.fromCharCode.apply(null, new Uint8Array(buf.slice(0, 5)));
    if (!head.startsWith('%PDF')) {
      throw new Error(`返回的不是 PDF（${buf.byteLength} 字节，可能是登录页/错误页）`);
    }
  }

  // 跨域 PDF（invoice 常放在 CDN 上）走 GM_xmlhttpRequest，避免 CORS 拦截
  function fetchPdfBlobViaGM(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        withCredentials: true,
        timeout: 45000,
        onload: (res) => {
          if (res.status === 429 || res.status === 403 || res.status === 402) {
            return reject(new RiskError(`HTTP ${res.status}（疑似限流/风控）`));
          }
          if (res.status === 401) return reject(new RiskError('HTTP 401（登录已失效）'));
          if (res.status < 200 || res.status >= 300) return reject(new Error(`HTTP ${res.status}`));
          const buf = res.response;
          if (!buf || !buf.byteLength) return reject(new Error('空响应'));
          try {
            assertPdf(buf);
          } catch (e) {
            return reject(e);
          }
          resolve(new Blob([buf], { type: 'application/pdf' }));
        },
        onerror: () => reject(new Error('网络错误（GM_xmlhttpRequest）')),
        ontimeout: () => reject(new Error('请求超时（GM_xmlhttpRequest）')),
      });
    });
  }

  async function fetchPdfBlob(url) {
    if (isCrossOrigin(url) && typeof GM_xmlhttpRequest === 'function') {
      return fetchPdfBlobViaGM(url);
    }

    // 关键：必须带 credentials，否则 Uber 会返回登录页 HTML，存盘后就是坏 PDF
    const resp = await fetch(url, { credentials: 'include', redirect: 'follow' });

    if (resp.status === 429 || resp.status === 403 || resp.status === 402) {
      throw new RiskError(`HTTP ${resp.status}（疑似限流/风控）`);
    }
    if (resp.status === 401) throw new RiskError('HTTP 401（登录已失效）');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const buf = await resp.arrayBuffer();
    try {
      assertPdf(buf);
    } catch (e) {
      const ct = resp.headers.get('content-type') || 'unknown';
      throw new Error(`${e.message}（content-type=${ct}）`);
    }
    return new Blob([buf], { type: 'application/pdf' });
  }

  function anchorSave(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return Promise.resolve();
  }

  function gmSave(blob, filename) {
    if (typeof GM_download !== 'function') return Promise.reject(new Error('GM_download 不可用'));
    const url = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (ok, err) => {
        if (settled) return;
        settled = true;
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        if (ok) resolve(); else reject(err);
      };
      try {
        GM_download({
          url,
          name: filename,
          saveAs: CFG.saveAs,
          onload: () => done(true),
          onerror: (e) => done(false, new Error((e && e.error) || 'GM_download 失败')),
          ontimeout: () => done(false, new Error('GM_download 超时')),
        });
      } catch (e) {
        done(false, e);
      }
    });
  }

  async function saveBlob(blob, filename) {
    if (CFG.useGM_download) {
      try {
        await gmSave(blob, filename);
        return 'GM_download';
      } catch (e) {
        logLine(`GM_download 失败（${e.message}），改用 <a download>`, 'warn');
      }
    }
    await anchorSave(blob, filename);
    return 'a[download]';
  }

  // 单笔：解析地址 → 取 PDF → 存盘。带重试与风控冷却。
  async function downloadOne(trip) {
    const label = safeName(trip.title || trip.subtitle || trip.description || 'Uber trip');
    const datePart = trip.dateMs ? fmtDate(new Date(trip.dateMs)) : '';

    let attempt = 0;
    let riskEvents = 0;
    let lastErr = null;

    while (attempt <= CFG.maxRetry) {
      if (state.stopRequested) throw new StopError('用户停止');

      try {
        const resolved = await resolvePdfUrl(trip);
        if (!resolved) throw new Error('找不到收据（可能已取消 / 行程未完成 / 无票据）');

        const blob = await fetchPdfBlob(resolved.url);
        const filename = `Uber_${datePart ? datePart + '_' : ''}${trip.uuid.slice(0, 8)}.pdf`;
        const how = await saveBlob(blob, filename);

        return {
          status: 'ok',
          kind: resolved.kind,
          filename,
          message: `${how} · ${Math.round(blob.size / 1024)} KB · ${label}`,
        };
      } catch (e) {
        if (e instanceof StopError) throw e;
        lastErr = e;
        attempt++;

        if (e instanceof RiskError) {
          riskEvents++;
          if (riskEvents > 2) {
            lastErr = new Error(`${e.message}（多次触发限流，已放弃该笔）`);
            break;
          }
          logLine(`⚠ 触发限流/风控：${e.message}，冷却 ${Math.round(CFG.cooldownAfterRiskMs / 1000)} 秒…`, 'warn');
          await countdownSleep(CFG.cooldownAfterRiskMs);
          attempt--; // 冷却等待不计入重试次数
          continue;
        }

        if (attempt <= CFG.maxRetry) {
          const backoff = 1500 * attempt + rand(0, 800);
          logLine(`第 ${attempt} 次失败（${e.message}），${Math.round(backoff / 1000)}s 后重试`, 'warn');
          await sleep(backoff);
        }
      }
    }

    return { status: 'fail', kind: '', filename: '', message: lastErr ? lastErr.message : '未知错误' };
  }

  async function countdownSleep(totalMs) {
    const step = 1000;
    for (let left = totalMs; left > 0; left -= step) {
      if (state.stopRequested) return;
      setProgress(`冷却中… ${Math.ceil(left / 1000)}s`);
      await sleep(Math.min(step, left));
    }
  }

  /* =========================================================
   * 9. 主流程
   * =======================================================*/
  async function runBatch({ mode }) {
    const startVal = ui.start.value;
    const endVal = ui.end.value;
    if (!startVal || !endVal) {
      setProgress('请先选择开始日期和结束日期。');
      return;
    }
    const startMs = dayStartMs(startVal);
    const endMs = dayEndMs(endVal);
    if (startMs > endMs) {
      setProgress('开始日期不能晚于结束日期。');
      return;
    }

    state.stopRequested = false;
    state.results = [];
    ui.log.textContent = '';
    setRunning(true, mode === 'download');
    setBar(0, 0);
    logLine(`范围：${startVal} ~ ${endVal}`);

    try {
      // —— 收集行程 ——
      let trips = [];
      if (CFG.apiFirst) {
        setProgress('正在通过接口获取行程列表…');
        try {
          trips = await collectTripsFromApi(startMs, endMs);
          logLine(`接口返回 ${trips.length} 条行程`, 'ok');
        } catch (e) {
          // 未登录 / 被限流：不要再去动页面，直接终止整轮
          if (e instanceof RiskError) throw e;
          logLine(`接口获取失败（${e.message}），改用滚动页面方式`, 'warn');
          trips = [];
        }
      }
      if (!trips.length) {
        setProgress('正在滚动加载行程列表…');
        trips = await collectTripsFromDom(startMs, endMs);
        logLine(`页面扫描到 ${trips.length} 条行程`, 'ok');
      }

      // —— 可选：过滤已取消 / 未完成 ——
      const usable = CFG.skipCanceledTrips
        ? trips.filter((t) => !SKIP_RE.test(`${t.title} ${t.subtitle} ${t.description}`))
        : trips;
      const skipped = trips.length - usable.length;
      if (skipped > 0) logLine(`跳过 ${skipped} 条已取消/未完成行程`, 'warn');

      const list = CFG.maxTripCount ? usable.slice(0, CFG.maxTripCount) : usable;

      if (!list.length) {
        setProgress('该日期范围内没有可下载的行程。\n若确认有行程，请检查登录状态或改用「预览」后再滚一屏页面重试。');
        return;
      }

      // —— 预览模式 ——
      if (mode === 'preview') {
        const head = list.slice(0, 8).map((t, i) => `  ${i + 1}. ${t.uuid.slice(0, 8)}  ${safeName(t.title || t.subtitle || '').slice(0, 40)}`).join('\n');
        setProgress(`预览：范围内共 ${list.length} 条行程。\n${head}${list.length > 8 ? '\n  …' : ''}\n\n确认无误后点「批量下载」。`);
        logLine(`预览完成：${list.length} 条`, 'ok');
        return;
      }

      // —— 下载 ——
      const total = list.length;
      logLine(`开始下载，共 ${total} 笔`, 'ok');
      let okCount = 0;
      let failCount = 0;
      let consecutiveFail = 0;

      for (let i = 0; i < total; i++) {
        if (state.stopRequested) {
          logLine('已按用户要求停止', 'warn');
          break;
        }

        const trip = list[i];
        setProgress(`正在下载 ${i + 1}/${total}\n第 ${i + 1} 笔 · ${safeName(trip.title || trip.subtitle || trip.uuid.slice(0, 8))}`);
        setBar(i, total);

        let res;
        try {
          res = await downloadOne(trip);
        } catch (e) {
          if (e instanceof StopError) {
            logLine('已按用户要求停止', 'warn');
            break;
          }
          res = { status: 'fail', kind: '', filename: '', message: e.message };
        }

        const record = {
          uuid: trip.uuid,
          label: safeName(trip.title || trip.subtitle || trip.description || ''),
          date: trip.dateMs ? msToDate(trip.dateMs) : '',
          kind: res.kind,
          filename: res.filename,
          status: res.status,
          message: res.message,
        };
        state.results.push(record);

        if (res.status === 'ok') {
          okCount++;
          consecutiveFail = 0;
          logLine(`✔ ${i + 1}/${total} ${res.filename}`, 'ok');
        } else {
          failCount++;
          consecutiveFail++;
          logLine(`✖ ${i + 1}/${total} ${trip.uuid.slice(0, 8)} — ${res.message}`, 'err');
          if (consecutiveFail >= CFG.consecutiveFailLimit) {
            logLine(`连续 ${consecutiveFail} 笔失败，为避免风控已自动停止。请稍后再试。`, 'err');
            break;
          }
        }

        if (i < total - 1) {
          // 分批：每 CFG.longPauseEvery 笔长休息一次
          if ((i + 1) % CFG.longPauseEvery === 0) {
            const wait = rand(CFG.longPauseMinMs, CFG.longPauseMaxMs);
            logLine(`已下载 ${i + 1} 笔，长休息 ${Math.round(wait / 1000)}s…`, 'warn');
            await countdownSleep(wait);
          } else {
            await delayBetweenDownloads();
          }
        }
      }

      setBar(total, total);
      const failedList = state.results.filter((r) => r.status === 'fail');
      setProgress(
        `完成：成功 ${okCount} 笔，失败 ${failCount} 笔。\n` +
        (failedList.length ? '失败项可点「重试失败项」。\n' : '') +
        '下载文件在浏览器默认下载目录。'
      );
      logLine(`结束：成功 ${okCount} / 失败 ${failCount}`, okCount ? 'ok' : 'warn');
    } catch (e) {
      logLine(`运行中断：${e.message}`, 'err');
      setProgress(`运行中断：${e.message}\n请稍后重试（不要连续狂点）。`);
    } finally {
      setRunning(false, false);
    }
  }

  async function retryFailed() {
    const failed = state.results.filter((r) => r.status === 'fail');
    if (!failed.length) {
      setProgress('没有失败项。');
      return;
    }

    state.stopRequested = false;
    setRunning(true, true);
    logLine(`重试 ${failed.length} 个失败项`, 'warn');

    let okCount = 0;
    try {
      for (let i = 0; i < failed.length; i++) {
        if (state.stopRequested) break;
        const rec = failed[i];
        setProgress(`正在重试 ${i + 1}/${failed.length}`);
        setBar(i, failed.length);

        const res = await downloadOne({ uuid: rec.uuid, title: rec.label, subtitle: '', description: '', dateMs: null }).catch(
          (e) => ({ status: 'fail', kind: '', filename: '', message: e.message })
        );

        rec.status = res.status;
        rec.kind = res.kind || rec.kind;
        rec.filename = res.filename || rec.filename;
        rec.message = res.message;

        if (res.status === 'ok') {
          okCount++;
          logLine(`✔ 重试成功 ${res.filename}`, 'ok');
        } else {
          logLine(`✖ 仍失败 ${rec.uuid.slice(0, 8)} — ${res.message}`, 'err');
        }
        if (i < failed.length - 1) await delayBetweenDownloads();
      }
      setBar(failed.length, failed.length);
      setProgress(`重试结束：成功 ${okCount}/${failed.length}。`);
    } finally {
      setRunning(false, false);
    }
  }

  function exportCsv() {
    if (!state.results.length) {
      setProgress('还没有结果可导出，先跑一次下载。');
      return;
    }
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const rows = [['date', 'uuid', 'type', 'status', 'filename', 'label', 'message'].join(',')];
    for (const r of state.results) {
      rows.push([r.date, r.uuid, r.kind, r.status, r.filename, r.label, r.message].map(esc).join(','));
    }
    // BOM 让 Excel 正确识别 UTF-8
    const blob = new Blob(['\ufeff' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `uber_receipts_${fmtDate(new Date())}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    logLine('已导出结果 CSV', 'ok');
  }

  /* =========================================================
   * 10. 注入时机：Uber 是 SPA，路由切换后要重新挂载
   * =======================================================*/
  function isTripsPage() {
    return /^\/trips(\/|$|\?)/.test(location.pathname);
  }

  function boot() {
    const host = document.body || document.documentElement;
    if (!host) return;
    if (!isTripsPage()) {
      if (state.running) return;   // 下载过程中不要拆面板
      if (ui.panel && ui.panel.parentElement) ui.panel.remove();
      ui.panel = null;
      return;
    }
    if (document.getElementById(PANEL_ID)) return;
    try {
      if (mountPanel()) console.info('[UberRC] 面板已注入 v1.0.2');
    } catch (e) {
      console.error('[UberRC] 面板注入失败', e);
    }
  }

  // 自检入口：TM 菜单 →「检查脚本是否运行」不通时，可在控制台输入 __uberRC.diag()
  function exposeDebugApi() {
    const api = {
      version: '1.0.2',
      diag() {
        return {
          url: location.href,
          pathname: location.pathname,
          isTripsPage: isTripsPage(),
          panelMounted: !!document.getElementById(PANEL_ID),
          bodyReady: !!document.body,
          running: state.running,
          resultCount: state.results.length,
          config: CFG,
        };
      },
      mount: boot,
    };
    try {
      if (typeof unsafeWindow !== 'undefined') unsafeWindow.__uberRC = api;
      window.__uberRC = api;
    } catch (_) { /* 某些沙箱不允许，忽略 */ }
  }

  exposeDebugApi();

  // 首次 + SPA 路由变化
  setInterval(boot, 1200);
  window.addEventListener('popstate', boot);
  window.addEventListener('hashchange', boot);
  boot();
})();
