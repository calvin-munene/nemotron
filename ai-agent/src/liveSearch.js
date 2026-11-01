const MAX_FEED_BYTES = 512 * 1024;

function xmlText(value = "") {
  return String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity])
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
      const number = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
      return Number.isInteger(number) && number >= 32 && number <= 0x10ffff ? String.fromCodePoint(number) : "";
    }).replace(/\s+/g, " ").trim();
}

function tag(item, name) {
  return xmlText(item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1] || "");
}

function publicLink(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || !url.hostname.includes(".") || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname)
      || url.hostname.includes(":") || value.length > 1200) return null;
    return url.href;
  } catch { return null; }
}

export function parseSearchFeed(xml, provider) {
  const results = [];
  for (const match of String(xml).matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const item = match[1];
    const url = publicLink(tag(item, "link"));
    const title = tag(item, "title").slice(0, 180);
    if (!url || !title) continue;
    const date = new Date(tag(item, "pubDate"));
    results.push({
      title, url, snippet: tag(item, "description").slice(0, 360),
      publishedAt: Number.isNaN(date.getTime()) ? null : date.toISOString(), provider
    });
    if (results.length >= 20) break;
  }
  return results;
}

export async function boundedText(response, maxBytes = MAX_FEED_BYTES) {
  if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("Tool response is too large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Tool response is too large");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function searchLiveWeb(query, { fetchImpl = fetch, signal } = {}) {
  if (typeof query !== "string" || query.trim().length < 3 || query.length > 240) {
    throw new Error("Live search requires a short, valid search query");
  }
  if (/nvapi-|bearer\s|(?:api[_ -]?key|password|secret|token)\s*[:=]|[\w.+-]+@[\w.-]+\.\w{2,}/i.test(query)) {
    const error = new Error("Remove private credentials and contact details before requesting a public web search.");
    error.publicMessage = error.message;
    throw error;
  }
  const feeds = [
    ["Google News", `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en&gl=KE&ceid=KE:en`],
    ["Bing web search", `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`]
  ];
  const outcomes = await Promise.allSettled(feeds.map(async ([provider, url]) => {
    const timeout = AbortSignal.timeout(12_000);
    const options = {
      redirect: "manual", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { accept: "application/rss+xml, application/xml, text/xml" }
    };
    let response = await fetchImpl(url, options);
    // Google News canonicalizes locale parameters with a same-host redirect.
    // Never follow search-provider redirects to arbitrary hosts.
    for (let hop = 0; [301, 302, 303, 307, 308].includes(response.status) && hop < 2; hop++) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Invalid search redirect");
      const target = new URL(location, url);
      if (target.protocol !== "https:" || target.host !== new URL(url).host
        || target.username || target.password) throw new Error("Unsafe search redirect");
      await boundedText(response, 16384);
      response = await fetchImpl(target.href, options);
    }
    if (!response.ok) throw new Error("Free search source unavailable");
    return parseSearchFeed(await boundedText(response), provider);
  }));
  const seen = new Set();
  const tokens = query.toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((token) =>
    !["what", "when", "where", "which", "latest", "current", "today", "news", "the", "and", "for", "with", "how", "2026",
      "summarize", "summary", "tell", "show", "give", "please", "about", "find", "search", "report", "reports", "this", "that", "are", "has", "was"].includes(token)) || [];
  const results = outcomes.flatMap((result) => result.status === "fulfilled" ? result.value : [])
    .filter((item) => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      const content = `${item.title} ${item.snippet}`.toLowerCase();
      return !tokens.length || tokens.filter((token) => content.includes(token)).length >= Math.min(2, tokens.length);
    }).sort((a, b) => {
      if (a.provider !== b.provider) return a.provider === "Google News" ? -1 : 1;
      return (Date.parse(b.publishedAt || "") || 0) - (Date.parse(a.publishedAt || "") || 0);
    }).slice(0, 4);
  if (!results.length) {
    const error = new Error("Free search returned no relevant sources");
    error.publicMessage = "The free live-search sources could not return relevant results right now. I cannot verify this from current sources. Please try a more specific query; no paid search service was used.";
    throw error;
  }
  return { results, retrievedAt: new Date().toISOString() };
}