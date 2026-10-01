const LEGACY_SOURCE = {
  id: "ithome",
  name: "IT之家",
  url: "https://www.ithome.com/rss/",
  enabled: true,
  mergeEnabled: true,
};
const MAX_SOURCES = 20;
const MAX_KEYWORDS = 200;
const MAX_FEED_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 12_000;

function response(body, status = 200, type = "text/plain") {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": `${type}; charset=utf-8`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
    },
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;",
  })[c]);
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&apos;",
  })[c]);
}

function xmlDecode(value) {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ""; }
    })
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(Number(n)); } catch { return ""; }
    })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function textContent(value) {
  return xmlDecode(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ").trim();
}

function field(block, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(
    `<(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}\\s*>`, "i"));
  return match ? textContent(match[1]) : "";
}

function attribute(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match ? xmlDecode(match[2]) : "";
}

function authorized(request, password) {
  try {
    const header = request.headers.get("Authorization") || "";
    if (!header.startsWith("Basic ")) return false;
    return atob(header.slice(6)) === `admin:${password}`;
  } catch {
    return false;
  }
}

function normalizeKeywords(config) {
  const list = Array.isArray(config.excludeKeywords)
    ? config.excludeKeywords
    : String(config.exclude || "").split(/\r?\n/);
  return [...new Map(list.map(value => String(value).trim())
    .filter(Boolean).map(value => [value.toLowerCase(), value])).values()];
}

function normalizeSource(source) {
  return {
    id: String(source.id || crypto.randomUUID()),
    name: String(source.name || "未命名订阅源").slice(0, 80),
    url: String(source.url || "").slice(0, 2048),
    enabled: source.enabled !== false,
    mergeEnabled: source.mergeEnabled === true,
  };
}

function normalizeConfig(value) {
  const stored = value && typeof value === "object" ? value : {};
  const sources = Array.isArray(stored.sources)
    ? stored.sources.map(normalizeSource).filter(source => source.url)
    : [{ ...LEGACY_SOURCE }];
  return { sources: sources.slice(0, MAX_SOURCES), excludeKeywords: normalizeKeywords(stored) };
}

async function readConfig(env) {
  if (!env.CONFIG) throw new Error("尚未绑定 CONFIG");
  return normalizeConfig(await env.CONFIG.get("rules", "json"));
}

async function saveConfig(env, config) {
  await env.CONFIG.put("rules", JSON.stringify(config));
}

function isLocalHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (host.includes(":")) return true;
  return false;
}

function validateSourceUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("订阅地址格式不正确"); }
  if (url.protocol !== "https:") throw new Error("订阅地址必须使用 HTTPS");
  if (url.username || url.password || isLocalHost(url.hostname)) {
    throw new Error("订阅地址不能包含账号信息或本机地址");
  }
  if (url.port && url.port !== "443") throw new Error("订阅地址只支持 HTTPS 默认端口");
  url.hash = "";
  return url.toString();
}

function parseFeed(xml, baseUrl) {
  if (xml.length > MAX_FEED_BYTES) throw new Error("订阅内容超过 2 MB");
  const rss = /<rss\b/i.test(xml) && /<channel\b/i.test(xml);
  const atom = /<(?:[\w.-]+:)?feed\b/i.test(xml);
  if (!rss && !atom) throw new Error("地址没有返回有效的 RSS 或 Atom 订阅");

  const titleMatch = rss
    ? xml.match(/<channel\b[^>]*>([\s\S]*?)<\/channel\s*>/i)
    : xml.match(/<(?:[\w.-]+:)?feed\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?feed\s*>/i);
  const channel = titleMatch ? titleMatch[1] : xml;
  const name = field(channel, "title");
  const entryRe = rss ? /<item\b[^>]*>[\s\S]*?<\/item\s*>/gi
    : /<(?:[\w.-]+:)?entry\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?entry\s*>/gi;
  const blocks = [...xml.matchAll(entryRe)].map(match => match[0]);
  const items = blocks.map((block, index) => {
    const title = field(block, "title");
    let link = "";
    if (rss) link = field(block, "link");
    else {
      const links = [...block.matchAll(/<(?:[\w.-]+:)?link\b([^>]*)\/?\s*>/gi)];
      const chosen = links.find(match => !attribute(match[1], "rel") ||
        attribute(match[1], "rel") === "alternate") || links[0];
      link = chosen ? attribute(chosen[1], "href") : "";
    }
    try { if (link) link = new URL(link, baseUrl).toString(); } catch { link = ""; }
    const dateText = field(block, "pubDate") || field(block, "published") ||
      field(block, "updated") || field(block, "date");
    const date = dateText ? new Date(dateText) : null;
    const description = field(block, "description") || field(block, "summary") ||
      field(block, "content") || field(block, "encoded");
    return {
      title: title || "（无标题）",
      link,
      guid: field(block, "guid") || field(block, "id") || link || `${index}`,
      date: date && !Number.isNaN(date.getTime()) ? date : null,
      description: textContent(description).slice(0, 4000),
    };
  }).filter(item => item.link);

  return { name: name || new URL(baseUrl).hostname, items };
}

async function fetchFeed(rawUrl) {
  let current = validateSourceUrl(rawUrl);
  for (let redirects = 0; redirects <= 4; redirects++) {
    const result = await fetch(current, {
      headers: { Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml" },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if ([301, 302, 303, 307, 308].includes(result.status)) {
      const location = result.headers.get("Location");
      if (!location || redirects === 4) throw new Error("订阅地址重定向次数过多");
      current = validateSourceUrl(new URL(location, current).toString());
      continue;
    }
    if (!result.ok) throw new Error(`订阅源返回 HTTP ${result.status}`);
    const length = Number(result.headers.get("Content-Length") || 0);
    if (length > MAX_FEED_BYTES) throw new Error("订阅内容超过 2 MB");
    const xml = await result.text();
    return { finalUrl: current, feed: parseFeed(xml, current) };
  }
  throw new Error("无法读取订阅源");
}

function page(config, message = "") {
  const sources = config.sources.map(source => `
<article class="source">
  <div class="source-head"><div><strong>${escapeHtml(source.name)}</strong>
  <div class="url">${escapeHtml(source.url)}</div></div>
  <form method="post" action="/sources/delete" onsubmit="return confirm('删除这个订阅源？')">
    <input type="hidden" name="id" value="${escapeHtml(source.id)}"><button class="danger">删除</button>
  </form></div>
  <form class="settings" method="post" action="/sources/update">
    <input type="hidden" name="id" value="${escapeHtml(source.id)}">
    <label class="switch"><input type="checkbox" name="enabled" ${source.enabled ? "checked" : ""}> 纳入总 RSS</label>
    <label class="switch"><input type="checkbox" name="mergeEnabled" ${source.mergeEnabled ? "checked" : ""}> 开启同类合并</label>
    <button>保存订阅源设置</button>
  </form>
</article>`).join("");
  const tags = config.excludeKeywords.map(keyword => `
<form class="tag" method="post" action="/keywords/delete">
  <input type="hidden" name="keyword" value="${escapeHtml(keyword)}">
  <span>${escapeHtml(keyword)}</span><button aria-label="删除 ${escapeHtml(keyword)}">×</button>
</form>`).join("");

  return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RSS 订阅管理</title>
<style>
:root{font-family:system-ui,-apple-system,sans-serif;color:#20242b;background:#f5f7fb}
*{box-sizing:border-box}body{max-width:760px;margin:28px auto;padding:0 18px;line-height:1.55}
h1{font-size:25px;margin:0 0 6px}.intro,.hint{color:#626b79;font-size:14px}
section{background:white;border:1px solid #e4e8ef;border-radius:14px;padding:20px;margin:18px 0}
h2{font-size:18px;margin:0 0 14px}input[type=text],input[type=url]{width:100%;padding:11px 12px;border:1px solid #ccd3df;border-radius:9px;font-size:15px}
button{border:0;border-radius:9px;background:#1769e0;color:white;padding:10px 15px;font-size:14px;cursor:pointer}
label{display:block;font-weight:600;margin:10px 0 6px}.source{border:1px solid #e5e9f0;border-radius:12px;padding:14px;margin:12px 0}
.source-head,.settings{display:flex;align-items:center;justify-content:space-between;gap:10px}.url{font-size:12px;color:#6a7380;overflow-wrap:anywhere;margin-top:3px}
.settings{justify-content:flex-start;flex-wrap:wrap;margin-top:12px}.settings .switch{font-size:14px;font-weight:500;margin:0 8px 0 0}.settings button{margin-left:auto}
.danger{background:#fff;color:#b42318;border:1px solid #f1d0ce;padding:7px 10px}.tag-list{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
.tag{display:inline-flex;align-items:center;gap:8px;background:#eaf2ff;color:#164b9c;border-radius:999px;padding:5px 8px 5px 12px;font-size:14px}
.tag button{color:#164b9c;background:transparent;padding:0 2px;font-size:19px;line-height:1}.add-row{display:flex;gap:8px}.add-row input{flex:1;min-width:0}
.notice{padding:12px 14px;background:#eaf6ef;border-radius:10px;color:#176039}.error{background:#fff1f0;color:#9f241c}
.feed-link{display:inline-block;margin:0 0 24px;color:#1769e0}
</style>
<h1>RSS 订阅管理</h1>
<p class="intro">维护订阅源和全局过滤词。所有启用的订阅源合并输出到一个 RSS 地址。</p>
${message ? `<p class="notice ${message.startsWith("错误：") ? "error" : ""}">${escapeHtml(message)}</p>` : ""}
<section><h2>订阅源</h2>
${sources || `<p class="hint">还没有订阅源，请添加一个 RSS 或 Atom 地址。</p>`}
<form method="post" action="/sources/add">
  <label for="source-url">添加订阅地址</label>
  <input id="source-url" name="url" type="url" required maxlength="2048" placeholder="https://example.com/feed.xml">
  <label for="source-name">显示名称（可选，默认读取订阅源名称）</label>
  <input id="source-name" name="name" type="text" maxlength="80" placeholder="例如：少数派">
  <p class="hint">添加时会请求订阅地址，检查 RSS/Atom 格式并读取名称。</p>
  <button>校验并添加</button>
</form></section>
<section><h2>全局排除关键词</h2>
<p class="hint">标题命中任一关键词即过滤。输入后按添加，每个关键词可单独删除。</p>
<div class="tag-list">${tags || `<span class="hint">还没有过滤关键词。</span>`}</div>
<form class="add-row" method="post" action="/keywords/add">
  <input name="keyword" type="text" required maxlength="100" placeholder="输入关键词">
  <button>添加</button>
</form></section>
<a class="feed-link" href="/rss" target="_blank" rel="noopener">打开总 RSS：/rss</a>
</html>`;
}

function sameOrigin(request, url) {
  return request.headers.get("Origin") === url.origin;
}

async function formPost(request, url, env, config) {
  if (!sameOrigin(request, url)) return response("拒绝跨站提交", 403);
  const form = await request.formData();
  const id = String(form.get("id") || "");

  if (url.pathname === "/sources/add") {
    const rawUrl = String(form.get("url") || "").trim();
    const customName = String(form.get("name") || "").trim().slice(0, 80);
    if (!rawUrl || config.sources.length >= MAX_SOURCES) {
      return response(page(config, "错误：订阅源不能为空，最多支持 20 个。"), 400, "text/html");
    }
    try {
      const safeUrl = validateSourceUrl(rawUrl);
      if (config.sources.some(source => source.url === safeUrl)) {
        throw new Error("这个订阅地址已经添加过了");
      }
      const { finalUrl, feed } = await fetchFeed(safeUrl);
      config.sources.push({
        id: crypto.randomUUID(),
        name: customName || feed.name,
        url: finalUrl,
        enabled: true,
        mergeEnabled: false,
      });
      await saveConfig(env, config);
      return response(page(config, `已添加并校验：${customName || feed.name}（找到 ${feed.items.length} 篇文章）`), 200, "text/html");
    } catch (error) {
      return response(page(config, `错误：${error.message || "订阅地址校验失败"}`), 400, "text/html");
    }
  }

  if (url.pathname === "/sources/update") {
    const source = config.sources.find(item => item.id === id);
    if (!source) return response(page(config, "错误：找不到这个订阅源。"), 404, "text/html");
    source.enabled = form.has("enabled");
    source.mergeEnabled = form.has("mergeEnabled");
    await saveConfig(env, config);
    return response(page(config, `已保存：${source.name}`), 200, "text/html");
  }

  if (url.pathname === "/sources/delete") {
    const before = config.sources.length;
    config.sources = config.sources.filter(item => item.id !== id);
    if (before === config.sources.length) return response(page(config, "错误：找不到这个订阅源。"), 404, "text/html");
    await saveConfig(env, config);
    return response(page(config, "已删除订阅源。"), 200, "text/html");
  }

  if (url.pathname === "/keywords/add") {
    const keyword = String(form.get("keyword") || "").trim();
    if (!keyword || /[\r\n]/.test(keyword)) return response(page(config, "错误：请输入一个不含换行的关键词。"), 400, "text/html");
    if (config.excludeKeywords.some(item => item.toLowerCase() === keyword.toLowerCase())) {
      return response(page(config, `已存在：${keyword}`), 200, "text/html");
    }
    if (config.excludeKeywords.length >= MAX_KEYWORDS ||
        config.excludeKeywords.join("").length + keyword.length > 10000) {
      return response(page(config, "错误：关键词数量或总长度超过限制。"), 400, "text/html");
    }
    config.excludeKeywords.push(keyword);
    await saveConfig(env, config);
    return response(page(config, `已添加关键词：${keyword}`), 200, "text/html");
  }

  if (url.pathname === "/keywords/delete") {
    const keyword = String(form.get("keyword") || "");
    config.excludeKeywords = config.excludeKeywords.filter(item => item !== keyword);
    await saveConfig(env, config);
    return response(page(config, `已删除关键词：${keyword}`), 200, "text/html");
  }

  return response("Not found", 404);
}

function dateKey(date) {
  return date ? new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date) : "unknown";
}

const COMMON_TITLE_WORDS = [
  "正式发布", "正式推出", "宣布推出", "消息称", "消息显示", "有望发布", "即将发布",
  "正式亮相", "全新发布", "重磅发布", "新品发布", "发布会", "发布了", "发布", "亮相",
  "曝光", "流出", "售价", "价格", "配置", "参数", "外观", "性能", "体验", "首发",
  "开售", "上市", "推出", "官宣", "曝出", "现身", "升级", "更新", "支持", "搭载",
  "手机", "笔记本", "平板电脑", "智能手机", "最新消息", "独家", "来了", "来了！",
];

function topicKeys(title) {
  let normalized = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  for (const word of COMMON_TITLE_WORDS) normalized = normalized.replaceAll(word, "");
  const keys = new Set();
  const latin = normalized.match(/[a-z]{2,}\d+[a-z0-9]*|\d+[a-z][a-z0-9]*|[a-z]{5,}/g) || [];
  for (const token of latin) {
    if (!/^(apple|iphone|ipad|macbook|xiaomi|huawei|honor|oppo|vivo|samsung|google)$/.test(token)) keys.add(token);
  }
  const cjk = normalized.match(/[\u3400-\u9fff]{4,}/g) || [];
  for (const run of cjk) {
    for (let size = 4; size <= Math.min(8, run.length); size++) {
      for (let i = 0; i <= run.length - size; i++) keys.add(run.slice(i, i + size));
    }
  }
  return keys;
}

function mergeItems(items) {
  const byDay = new Map();
  for (const item of items) {
    const day = dateKey(item.date);
    if (day === "unknown") byDay.set(`unknown-${item.link}`, [item]);
    else {
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(item);
    }
  }
  const groups = [];
  for (const dayItems of byDay.values()) {
    const parent = dayItems.map((_, index) => index);
    const keys = dayItems.map(item => topicKeys(item.title));
    const find = index => parent[index] === index ? index : (parent[index] = find(parent[index]));
    for (let i = 0; i < dayItems.length; i++) {
      for (let j = i + 1; j < dayItems.length; j++) {
        let matchingTopic = false;
        for (const key of keys[i]) {
          if (keys[j].has(key)) { matchingTopic = true; break; }
        }
        if (matchingTopic) parent[find(i)] = find(j);
      }
    }
    const dayGroups = new Map();
    dayItems.forEach((item, index) => {
      const root = find(index);
      if (!dayGroups.has(root)) dayGroups.set(root, []);
      dayGroups.get(root).push(item);
    });
    groups.push(...dayGroups.values());
  }
  return groups.map(group => {
    if (group.length === 1) return group[0];
    group.sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));
    const representative = group[0];
    return {
      ...representative,
      guid: `merged-${representative.sourceId}-${dateKey(representative.date)}-${hashText(representative.link)}`,
      description: group.map(item => `<p><a href="${escapeHtml(item.link)}">${escapeHtml(item.title)}</a></p>`).join(""),
      isMerged: true,
    };
  });
}

function hashText(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

function buildRss(items, sources) {
  const sourceList = sources.map(source => escapeXml(source.name)).join("、");
  const outputItems = items.map(item => {
    const description = item.isMerged
      ? item.description
      : escapeHtml(item.description || "");
    return `<item><title>${escapeXml(item.title)}</title><link>${escapeXml(item.link)}</link>` +
      `<guid isPermaLink="false">${escapeXml(item.guid)}</guid>` +
      `${item.date ? `<pubDate>${item.date.toUTCString()}</pubDate>` : ""}` +
      `<category>${escapeXml(item.sourceName)}</category>` +
      `<description><![CDATA[${description.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]></description></item>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>` +
    `<title>RSS 聚合与过滤</title><link>https://rss-filter.leehaozhen.workers.dev/</link>` +
    `<description>合并订阅源：${sourceList}</description>${outputItems}</channel></rss>`;
}

async function aggregate(config) {
  const active = config.sources.filter(source => source.enabled);
  const results = await Promise.all(active.map(async source => {
    try {
      const { feed } = await fetchFeed(source.url);
      const items = feed.items.map(item => ({ ...item, sourceId: source.id, sourceName: source.name }));
      return { source, items, error: "" };
    } catch (error) {
      return { source, items: [], error: error.message || "读取失败" };
    }
  }));
  const failed = results.filter(result => result.error);
  const allItems = results.flatMap(result => result.items);
  const seen = new Set();
  const unique = allItems.filter(item => {
    const key = item.link || `${item.sourceId}:${item.guid}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const excludes = config.excludeKeywords.map(keyword => keyword.toLowerCase());
  const filtered = unique.filter(item =>
    !excludes.some(keyword => item.title.toLowerCase().includes(keyword)));
  const merged = [];
  for (const result of results) {
    const sourceItems = filtered.filter(item => item.sourceId === result.source.id);
    merged.push(...(result.source.mergeEnabled ? mergeItems(sourceItems) : sourceItems));
  }
  merged.sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));
  return { items: merged, failed, enabledCount: active.length, total: unique.length, kept: filtered.length };
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (!env.CONFIG) return response("请先绑定 CONFIG", 503);

      if (url.pathname === "/api/keywords") {
        const json = (data, status = 200) => response(JSON.stringify(data), status, "application/json");
        if (request.method !== "POST") return json({ ok: false, message: "请使用 POST" }, 405);
        if (!env.API_KEY || request.headers.get("Authorization") !== `Bearer ${env.API_KEY}`) {
          return json({ ok: false, message: "接口密钥错误" }, 401);
        }
        let body;
        try { body = await request.json(); } catch { return json({ ok: false, message: "请求必须是 JSON" }, 400); }
        const keyword = typeof body?.keyword === "string" ? body.keyword.trim() : "";
        if (!keyword || keyword.length > 100 || /[\r\n]/.test(keyword)) {
          return json({ ok: false, message: "请输入单个关键词，长度为 1～100 字符" }, 400);
        }
        const config = await readConfig(env);
        if (config.excludeKeywords.some(item => item.toLowerCase() === keyword.toLowerCase())) {
          return json({ ok: true, message: `已存在：${keyword}` });
        }
        if (config.excludeKeywords.length >= MAX_KEYWORDS ||
            config.excludeKeywords.join("").length + keyword.length > 10000) {
          return json({ ok: false, message: "关键词数量或总长度超过限制" }, 400);
        }
        config.excludeKeywords.push(keyword);
        await saveConfig(env, config);
        return json({ ok: true, message: `已添加：${keyword}` });
      }

      if (url.pathname === "/rss") {
        if (request.method !== "GET") return response("Method not allowed", 405);
        const config = await readConfig(env);
        const result = await aggregate(config);
        if (result.enabledCount && !result.total && result.failed.length === result.enabledCount) {
          return response("所有启用的订阅源暂时都无法读取，请检查订阅源设置。", 502);
        }
        const res = response(buildRss(result.items, config.sources.filter(source => source.enabled)), 200, "application/rss+xml");
        res.headers.set("X-RSS-Total", String(result.total));
        res.headers.set("X-RSS-Kept", String(result.kept));
        res.headers.set("X-RSS-Sources", String(result.enabledCount));
        res.headers.set("X-RSS-Failed-Sources", String(result.failed.length));
        return res;
      }

      if (!env.ADMIN_PASSWORD) return response("请先设置 ADMIN_PASSWORD", 503);
      if (!authorized(request, env.ADMIN_PASSWORD)) {
        const res = response("请输入管理用户名和密码", 401);
        res.headers.set("WWW-Authenticate", 'Basic realm="RSS Admin", charset="UTF-8"');
        return res;
      }

      if (url.pathname === "/") {
        if (request.method === "GET") return response(page(await readConfig(env)), 200, "text/html");
        if (request.method === "POST") return formPost(request, url, env, await readConfig(env));
        return response("Method not allowed", 405);
      }

      if (url.pathname.startsWith("/sources/") || url.pathname.startsWith("/keywords/")) {
        if (request.method !== "POST") return response("Method not allowed", 405);
        return formPost(request, url, env, await readConfig(env));
      }

      return response("Not found", 404);
    } catch {
      return response("处理失败：请查看 Worker 日志，或稍后重试", 502);
    }
  },
};
