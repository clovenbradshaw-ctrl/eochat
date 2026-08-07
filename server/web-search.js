import { distillSubject } from "./holonic-chat.js";

const SEARCH_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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

  // Backend 3: Wikipedia search + plain-text extracts — the default lookup.
  // A typed API, always real article content, and the right starting point for
  // provenance: once we have an article we can follow its cited sources to
  // the primary material (see researchTopic below). Kept ahead of the scraper
  // so the default is a reliable, citeable page rather than a search-index
  // scrape whose top result may be a JS shell.
  try {
    const wikiResults = await fetchWikipedia(query, numResults, maxChars);
    if (wikiResults.length > 0) return wikiResults;
  } catch { /* fall through */ }

  // Backend 4: DuckDuckGo HTML search — real ranked results with real host
  // URLs, unlike the Instant Answer API below (whose "results" are DDG's own
  // JS-shell topic pages that serve no fetchable article). The anchor URLs
  // come wrapped as //duckduckgo.com/l/?uddg=<encoded>; decode to the actual
  // article URL so webFetch can pull real body text. Used as the breadth
  // fallback when Wikipedia has no good article for the query.
  try {
    const ddgHtmlResults = await fetchDuckDuckGoHtml(query, numResults, maxChars);
    if (ddgHtmlResults.length > 0) return ddgHtmlResults;
  } catch { /* fall through */ }

  // Backend 5: DuckDuckGo Instant Answer API — a typed JSON response, same
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

// Unwrap DDG's /l/?uddg=<urlencoded> redirect to the real article URL.
function decodeDdgRedirect(url) {
  const s = String(url || "");
  const m = s.match(/uddg=([^&]+)/);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch {}
  }
  return s.startsWith("//") ? "https:" + s : s;
}

async function fetchDuckDuckGoHtml(query, numResults, maxChars) {
  const resp = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": SEARCH_UA },
    signal: AbortSignal.timeout(12000),
  });
  if (!resp.ok) return [];
  const html = await resp.text();

  const anchors = [...html.matchAll(/class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];

  const out = [];
  for (let i = 0; i < anchors.length && out.length < numResults; i++) {
    const title = anchors[i][2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const url = decodeDdgRedirect(anchors[i][1]);
    if (!title || !url || !/^https?:\/\//.test(url)) continue;
    const snippet = (snippets[i]?.[1] || "")
      .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      .slice(0, Math.floor(maxChars / numResults));
    out.push({ title, url, snippet, source: "duckduckgo" });
  }
  return out;
}

async function fetchWikipedia(query, numResults, maxChars) {
  // A search query must be a noun phrase, not the raw reader sentence: the
  // full "Write me a 5 page essay about dolphins, after researching online
  // first." fed to the search API matches stray words ("essay" → Voltaire),
  // not the subject. distillSubject only rewrites instruction/essay phrasing;
  // genuine topical queries pass through unchanged.
  query = distillSubject(query) || query;
  const searchResp = await fetch(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}` +
    `&srlimit=${Math.min(numResults, 5)}&format=json&origin=*`,
    { headers: { "User-Agent": SEARCH_UA }, signal: AbortSignal.timeout(10000) },
  );
  if (!searchResp.ok) return [];
  const searchData = await searchResp.json();
  const hits = searchData?.query?.search || [];

  const perResultChars = Math.floor(maxChars / numResults);
  const out = [];
  for (const h of hits.slice(0, numResults)) {
    const title = h.title;
    const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
    let text = "";
    try {
      const exResp = await fetch(
        `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&origin=*` +
        `&titles=${encodeURIComponent(title)}`,
        { headers: { "User-Agent": SEARCH_UA }, signal: AbortSignal.timeout(10000) },
      );
      if (exResp.ok) {
        const exData = await exResp.json();
        const pages = exData?.query?.pages || {};
        const page = pages[Object.keys(pages)[0]];
        text = (page?.extract || "").trim();
      }
    } catch { /* keep snippet-only */ }
    const snippet = text.slice(0, perResultChars) ||
      (h.snippet || "").replace(/<[^>]+>/g, " ").trim().slice(0, perResultChars);
    out.push({ title, url, snippet, text, source: "wikipedia" });
  }
  return out;
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
  // Search wider than requested: an essay's research is only as real as the
  // content it can actually fetch, and a result whose page serves nothing
  // (paywall, JS shell, 403) is worthless for grounding even with a perfect
  // title and snippet. Fetch until we have `numResults` results with real
  // body text, then stop — real content wins over search rank.
  const results = await webSearch(query, { numResults: numResults * 2 });
  const withText = [];
  for (const r of results) {
    r.text = await webFetch(r.url, { maxChars: maxFetchChars });
    if (r.text) {
      withText.push(r);
      if (withText.length >= numResults) break;
    }
  }
  return withText;
}

// ---------------------------------------------------------------------------
// Provenance research — the good-habits path.
//
// Default lookup is Wikipedia: a typed API with real article content. Then we
// follow the article's OWN cited sources to the primary material — the works,
// papers, records, and official sites the article actually cites — and fetch
// those. The result carries provenance at every hop, so an essay built on it
// can name not just "Wikipedia said X" but "article A cites primary source B,
// which says X", and the reader can walk the chain themselves.
// ---------------------------------------------------------------------------

// Split wikitext into sections; return the text of the reference-bearing
// sections (References, Sources, Notes, Further reading, External links).
function referenceSections(wikitext) {
  const lines = String(wikitext || "").split("\n");
  const headers = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^==+\s*(.*?)\s*==+\s*$/);
    if (m) headers.push([i, m[1]]);
  }
  const refNames = /^(references|sources|notes|further\s*reading|external\s*links|bibliography|works\s*cited)/i;
  const out = [];
  for (let i = 0; i < headers.length; i++) {
    if (refNames.test(headers[i][1])) {
      const start = headers[i][0] + 1;
      const end = headers[i + 1] ? headers[i + 1][0] : lines.length;
      out.push(lines.slice(start, end).join("\n"));
    }
  }
  return out;
}

// The infobox "Official website" link is the subject's own site — the most
// primary source there is. Scan the whole wikitext for it.
function extractOfficialSite(wikitext) {
  const m = String(wikitext || "").match(/\{\{\s*[Oo]fficial\s+[Ww]ebsite[\s\S]*?\}\}/);
  if (!m) return null;
  const parts = m[0].slice(2, -2).split("|");
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i].trim();
    const val = p.replace(/^1\s*=\s*/, "").trim();
    if (/^https?:\/\//.test(val) && !/^[a-z0-9_-]+=/.test(val)) return val;
  }
  return null;
}

// Pull (url, title) candidates out of {{cite ...}} templates and bare external
// links. Templates are split on "|" then key=value on the first "=", so a URL
// with its own query string keeps its "=" intact.
function extractCitationCandidates(text) {
  const candidates = [];
  const t = String(text || "").replace(/\{\{\s*!?\s*\}\}/g, "");
  for (const m of t.matchAll(/\{\{\s*cite\s+\w+([\s\S]*?)\}\}/gi)) {
    const params = {};
    for (const part of m[1].split("|")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      const key = part.slice(0, eq).trim().toLowerCase();
      const val = part.slice(eq + 1).trim()
        .replace(/\{\{[\s\S]*?\}\}/g, "")
        .replace(/\[|\]/g, "")
        .replace(/^\/\//, "https://");
      if (key && !params[key]) params[key] = val;
    }
    const url = params.url || params.accessurl || "";
    const title = params.title || params.work || params.journal || params.newspaper || "";
    if (/^https?:\/\//.test(url)) candidates.push({ url, title });
  }
  for (const m of t.matchAll(/\[(https?:\/\/[^\s\]]+)[^\]]*\]/gi)) {
    candidates.push({ url: m[1], title: "" });
  }
  for (const m of t.matchAll(/(?:^|\s)(https?:\/\/[^\s\]<>|]+)/g)) {
    candidates.push({ url: m[1], title: "" });
  }
  return candidates;
}

// Domain weight is a provenance heuristic, not a law: a .gov archive or an
// arXiv paper is likelier to be primary material than a .com news aggregation
// of the same facts. Weighted candidates are sorted best-first, and the
// fetcher below is what actually decides — a candidate that serves no real
// text is dropped regardless of rank.
function rankPrimaryCandidates(candidates, officialSite) {
  const seen = new Set();
  const out = [];
  const push = (url, title, weight) => {
    const clean = String(url || "").split("#")[0].replace(/\/+$/, "");
    if (!/^https?:\/\//.test(clean)) return;
    let host;
    try { host = new URL(clean).hostname; } catch { return; }
    if (/wikipedia\.org$|wikimedia\.org$|mediawiki\.org$|duckduckgo\.com$/.test(host)) return;
    if (seen.has(clean)) return;
    seen.add(clean);
    out.push({ url: clean, title: String(title || ""), host, weight });
  };
  if (officialSite) push(officialSite, "Official website", 9);
  for (const c of candidates) {
    let host;
    try { host = new URL(c.url).hostname; } catch { continue; }
    let weight = 1;
    if (/\.gov$/.test(host) || /\.mil$/.test(host)) weight = 8;
    else if (/\.edu$/.test(host) || /\.ac\.[a-z]{2}$/.test(host)) weight = 7;
    else if (/arxiv\.org$/.test(host) || /doi\.org$/.test(host) || /pubmed\./.test(host)) weight = 7;
    else if (/\.org$/.test(host)) weight = 5;
    else if (/\.io$/.test(host)) weight = 3;
    else if (/\.com$/.test(host) || /\.net$/.test(host)) weight = 2;
    push(c.url, c.title, weight);
  }
  return out.sort((a, b) => b.weight - a.weight || a.url.localeCompare(b.url));
}

// Fetch the primary sources a Wikipedia article actually cites: parse the
// article's wikitext for its reference sections and infobox official site,
// rank the candidates, and fetch the top ones until `max` return real text.
async function fetchWikipediaPrimarySources(title, max, maxFetchChars) {
  try {
    const resp = await fetch(
      `https://en.wikipedia.org/w/api.php?action=parse&prop=wikitext&format=json&origin=*&page=${encodeURIComponent(title)}`,
      { headers: { "User-Agent": SEARCH_UA }, signal: AbortSignal.timeout(12000) },
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    const wikitext = data?.parse?.wikitext?.["*"] || "";
    const official = extractOfficialSite(wikitext);
    const sections = referenceSections(wikitext);
    const candidates = rankPrimaryCandidates(sections.map(extractCitationCandidates).flat(), official);

    const out = [];
    for (const c of candidates) {
      const text = await webFetch(c.url, { maxChars: maxFetchChars });
      if (text) {
        out.push({ title: c.title || c.host, url: c.url, text });
        if (out.length >= max) break;
      }
    }
    return out;
  } catch {
    return [];
  }
}

// The provenance path itself: Wikipedia first (the default lookup), then the
// article's own cited primary sources. When Wikipedia has no article for the
// query, fall back to a general web search+fetch and say the hop was a fallback.
//
// Returns topics shaped for the essay planner:
//   { topic, article: {title,url,text,kind:"secondary"},
//     primarySources: [{title,url,text,kind:"primary"}],
//     provenance: [{kind,title,url}], fallback?: bool }
export async function researchTopic(query, { numResults = 2, maxFetchChars = 4000, primarySourcesPerArticle = 2 } = {}) {
  const articles = await fetchWikipedia(query, numResults, maxFetchChars);
  if (articles.length === 0) {
    const web = await webSearchAndFetch(query, { numResults, maxFetchChars });
    return web.map((r) => ({
      topic: r.title,
      article: { title: r.title, url: r.url, text: r.text, kind: "secondary" },
      primarySources: [],
      provenance: [{ kind: "secondary", title: r.title, url: r.url }],
      fallback: true,
    }));
  }

  const topics = [];
  for (const a of articles) {
    const primary = await fetchWikipediaPrimarySources(a.title, primarySourcesPerArticle, maxFetchChars);
    const provenance = [
      { kind: "secondary", title: a.title, url: a.url },
      ...primary.map((p) => ({ kind: "primary", title: p.title, url: p.url })),
    ];
    topics.push({
      topic: a.title,
      article: { title: a.title, url: a.url, text: a.text, kind: "secondary" },
      primarySources: primary.map((p) => ({ ...p, kind: "primary" })),
      provenance,
    });
  }
  return topics;
}
