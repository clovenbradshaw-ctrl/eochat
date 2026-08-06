export async function webSearch(query, { numResults = 5, maxChars = 8000 } = {}) {
  numResults = Math.min(numResults, 20);

  // Backend 1: Brave Search
  const braveKey = process.env.BRAVE_API_KEY;
  if (braveKey) {
    try {
      const braveUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(numResults, 10)}&safesearch=off`;
      const resp = await fetch(braveUrl, {
        headers: { "Accept": "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": braveKey },
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const data = await resp.json();
        const results = (data.web?.results || []).slice(0, numResults);
        if (results.length > 0) {
          return results.map((r, i) => ({
            rank: i + 1,
            title: r.title || "",
            url: r.url || "",
            snippet: (r.description || r.snippet || "").slice(0, maxChars / numResults),
            source: "brave",
          }));
        }
      }
    } catch { /* fall through */ }
  }

  // Backend 2: Serper.dev
  const serperKey = process.env.SERPER_API_KEY;
  if (serperKey) {
    try {
      const resp = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": serperKey },
        body: JSON.stringify({ q: query, num: numResults, gl: "us", hl: "en" }),
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const data = await resp.json();
        const results = (data.organic || []).slice(0, numResults);
        if (results.length > 0) {
          return results.map((r, i) => ({
            rank: i + 1,
            title: r.title || "",
            url: r.link || "",
            snippet: (r.snippet || "").slice(0, maxChars / numResults),
            source: "serper",
          }));
        }
      }
    } catch { /* fall through */ }
  }

  // Backend 3: DuckDuckGo Instant Answer API — a typed JSON response, same
  // as Brave and Serper above, not a scraped results page matched against a
  // markup pattern that breaks the moment DuckDuckGo changes its HTML. The
  // trade is real: this is an abstract-and-related-topics API, not a ranked
  // general search index, so it returns fewer, thinner results than a page
  // scrape would for a broad query — but every field it returns is a typed
  // JSON value, never a regex guess at where a title starts and ends.
  try {
    const ddgResults = await fetchDuckDuckGoInstantAnswer(query, numResults, maxChars);
    if (ddgResults.length > 0) return ddgResults;
  } catch { /* fall through */ }

  return [];
}

async function fetchDuckDuckGoInstantAnswer(query, numResults, maxChars) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
  const resp = await fetch(url, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) return [];
  const data = await resp.json();

  const entries = [];
  if (data.AbstractText) {
    entries.push({ title: data.Heading || query, url: data.AbstractURL || "", text: data.AbstractText });
  }
  for (const t of flattenDdgTopics(data.RelatedTopics)) {
    if (entries.length >= numResults) break;
    // DDG's Text field reads "Name - description"; split on the leading
    // " - " it always inserts so the title pill shows a name, not the
    // whole sentence. If a future response omits the separator, the
    // truncated fallback below is still a reasonable title.
    const dash = t.Text.indexOf(" - ");
    entries.push({ title: dash > -1 ? t.Text.slice(0, dash) : t.Text.slice(0, 80), url: t.FirstURL, text: t.Text });
  }

  return entries.slice(0, numResults).map((e, i) => ({
    rank: i + 1, title: e.title, url: e.url,
    snippet: e.text.slice(0, maxChars / numResults),
    source: "duckduckgo",
  }));
}

// RelatedTopics mixes flat {Text, FirstURL} entries with grouped
// {Name, Topics: [...]} categories at the top level — flatten both into the
// same shape rather than assuming every entry has the fields the flat case does.
export function flattenDdgTopics(topics) {
  const out = [];
  for (const t of topics || []) {
    if (Array.isArray(t?.Topics)) out.push(...flattenDdgTopics(t.Topics));
    else if (t?.Text && t?.FirstURL) out.push(t);
  }
  return out;
}

// DuckDuckGo's own topic pages (duckduckgo.com/<Slug>, duckduckgo.com/c/<Slug>)
// are a JS single-page app — fetched without a browser they serve nothing but
// a "you are being redirected to the non-JS site" shell, never the topic
// content. There is no real page behind this fetch to wait for; the search
// API's own Text/snippet field is the only real content DDG gives us for
// these, so skip the network round-trip and let the caller fall back to that.
function isUnfetchableStub(url) {
  try {
    const u = new URL(url);
    return /(^|\.)duckduckgo\.com$/.test(u.hostname) && !/^\/(html|lite)\//.test(u.pathname);
  } catch {
    return false;
  }
}

// The same "redirecting to the non-JS site" shell can come back from other
// JS-shell sites too, not just DuckDuckGo — a generic content check catches
// those without hardcoding every such host. A real page is never this short
// AND built entirely around the word "redirect".
function looksLikeRedirectStub(text) {
  return text.length < 400 && /redirect(ed|ing)?\s+to\s+the\s+non-javascript\s+site/i.test(text);
}

export async function webFetch(url, { maxChars = 10000 } = {}) {
  if (isUnfetchableStub(url)) return "";
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
      signal: AbortSignal.timeout(15000),
    });
    const text = await resp.text();
    const contentType = resp.headers.get("content-type") || "";
    const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml") || text.trim().startsWith("<");

    if (!isHtml) return text.slice(0, maxChars);

    const clean = text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, " ").trim();

    if (looksLikeRedirectStub(clean)) return "";
    return clean.slice(0, maxChars);
  } catch {
    return "";
  }
}

export async function webSearchAndFetch(query, { numResults = 3, maxFetchChars = 5000 } = {}) {
  const results = await webSearch(query, { numResults });
  for (const r of results) {
    r.text = await webFetch(r.url, { maxChars: maxFetchChars });
  }
  return results;
}
