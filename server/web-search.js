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

  // Backend 3: DuckDuckGo
  try {
    const resp = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (resp.ok) {
      const html = await resp.text();
      const results = [];
      const resultBlocks = html.split(/<div[^>]*\bclass="[^"]*\bresult__body\b[^"]*"[^>]*>/);
      for (let i = 1; i < resultBlocks.length && results.length < numResults; i++) {
        const block = resultBlocks[i];
        try {
          const titleMatch = block.match(/<a[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*>(.*?)<\/a>/s);
          const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "";
          const urlMatch = block.match(/<a[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*href="(.*?)"/) || block.match(/<a[^>]*href="(.*?)"[^>]*\bclass="[^"]*\bresult__a\b/);
          let url = urlMatch ? decodeDdgHref(urlMatch[1]) : "";
          if (url.startsWith("//")) url = "https:" + url;
          const snippetMatch = block.match(/<a[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>(.*?)<\/a>/s);
          let snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : "";
          if (!snippet) {
            const altMatch = block.match(/\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>(.*?)<\/(?:span|div|td)>/s);
            snippet = altMatch ? altMatch[1].replace(/<[^>]+>/g, "").trim() : "";
          }
          if (title && url) {
            results.push({ rank: results.length + 1, title, url, snippet: snippet.slice(0, maxChars / numResults), source: "duckduckgo" });
          }
        } catch { /* skip malformed result */ }
      }
      if (results.length > 0) return results;
    }
  } catch { /* fall through */ }

  return [];
}

export async function webFetch(url, { maxChars = 10000 } = {}) {
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

function decodeDdgHref(href) {
  if (!href) return "";
  let h = href.replace(/&amp;/g, "&");
  const m = h.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try { h = decodeURIComponent(m[1]); } catch { return ""; }
  }
  if (/\/y\.js\?|[?&]ad_provider=|[?&]ad_domain=/.test(h)) return "";
  return h;
}
