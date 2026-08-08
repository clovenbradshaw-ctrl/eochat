// Mechanical, model-blind citation checks — moved out of proxy.js so
// turn-controller.js can share them without importing proxy.js (which would
// create a cycle: proxy.js -> turn-controller.js -> proxy.js).
//
// Every check here runs AFTER the model's answer is complete, compares against
// engine-computed ground truth, and is never fed back into the prompt — the
// model cannot see or influence its own grade
// (specs/mechanical-citation-surface.md).
//
// The organising idea is one sentence: **a citation must point at something,
// and that something must contain what the sentence claims.** A bracket that
// points nowhere, a quotation that occurs nowhere, and a name or number that
// occurs nowhere in the passage it is attributed to are three shapes of the
// same failure — a citation into the void — and all three are decidable
// without asking a model anything.
//
// What is deliberately NOT here: any judgment of whether a claim is *true*, or
// whether a paraphrase *fairly represents* a passage. Those need a model, and
// a model grading its own answer is not a check. Everything below is literal
// string containment against bytes the engine already vouched for, so it
// cannot be argued with — which is the only property that makes it worth
// showing a reader.

// ── Bracket grammar ──────────────────────────────────────────────────────────
//
// Models do not restrict themselves to the [1] form they were asked for. A
// single regex for /\[(\d+)\]/ silently ignores [1,2] and [1-3], so an answer
// citing "[9,10]" against a three-passage table passed every check untouched:
// the exact fabricated-citation case this file exists to catch, escaping
// because of bracket syntax rather than anything about the claim. One parser
// now serves every caller, so bracket resolution and bracket validation can
// never drift into two different ideas of what a citation is.
//
// A range is expanded to its members ([2-4] -> 2,3,4) and bounded, so a
// malformed or absurd range ([1-99999]) can never make the checker allocate.
const MAX_RANGE_SPAN = 64;

const BRACKET_RE = /\[\s*(\d+(?:\s*(?:[,;]|-|–|—|to)\s*\d+)*)\s*\]/g;

/**
 * Every citation bracket in `text`, in order, with the numbers it names and
 * the character range it occupies. Handles [1], [1,2], [1, 2; 3], [1-3], and
 * the en/em-dash and "to" spellings of a range.
 *
 * @returns {{start:number,end:number,raw:string,nums:number[]}[]}
 */
export function parseCitationRefs(text) {
  const out = [];
  if (!text) return out;
  BRACKET_RE.lastIndex = 0;
  let m;
  while ((m = BRACKET_RE.exec(text)) !== null) {
    const nums = [];
    const body = m[1];
    // Split on list separators first, then expand any ranges inside each part.
    for (const part of body.split(/\s*[,;]\s*/)) {
      const range = part.match(/^(\d+)\s*(?:-|–|—|to)\s*(\d+)$/);
      if (range) {
        const lo = parseInt(range[1], 10);
        const hi = parseInt(range[2], 10);
        if (hi >= lo && hi - lo <= MAX_RANGE_SPAN) {
          for (let n = lo; n <= hi; n++) nums.push(n);
        } else {
          // A backwards or absurd range names no passage we can verify; keep
          // the endpoints so they are still checked rather than dropping the
          // bracket into silence.
          nums.push(lo, hi);
        }
        continue;
      }
      const single = part.match(/^\d+$/);
      if (single) nums.push(parseInt(part, 10));
    }
    if (nums.length) out.push({ start: m.index, end: m.index + m[0].length, raw: m[0], nums });
  }
  return out;
}

/**
 * An ungrounded answer (maxCitation === 0: no passages, no web results) has
 * nothing a bracket could point at — the system prompt tells the model not
 * to write [1]-style brackets at all, but a small local model does not
 * reliably obey that, and validateCitations below only fires when
 * maxCitation > 0. Without this, an invented "[1][2][3]" on a plain greeting
 * sails through untouched and the UI has to show it as three broken
 * citations instead of the model just not having written them.
 */
export function stripUngroundedCitations(content) {
  if (!content) return content;
  return content.replace(BRACKET_RE, "").replace(/[ \t]+([.,;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ");
}

/** Replace any [n] the model invented beyond the real citation table with a visible gap marker. */
export function validateCitations(content, maxCitation) {
  if (!content || maxCitation <= 0) return content;
  const refs = parseCitationRefs(content);
  if (!refs.length) return content;
  let out = "";
  let cursor = 0;
  for (const ref of refs) {
    const bad = ref.nums.filter((n) => !(n >= 1 && n <= maxCitation));
    if (!bad.length) continue;
    out += content.slice(cursor, ref.start);
    // A mixed bracket ([2,9] against a 3-passage table) must keep the real
    // citation intact and void only the invented number — voiding the whole
    // bracket would destroy a verifiable link to punish an adjacent mistake.
    const good = ref.nums.filter((n) => n >= 1 && n <= maxCitation);
    const parts = [];
    if (good.length) parts.push(`[${good.join(", ")}]`);
    parts.push(`[⊘ no source ${bad.join(", ")}]`);
    out += parts.join("");
    cursor = ref.end;
  }
  out += content.slice(cursor);
  return out;
}

// ── Normalisation ────────────────────────────────────────────────────────────

export function normalizeForFidelity(s) {
  return String(s || "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Quoted fidelity ──────────────────────────────────────────────────────────

const QUOTE_RE = /[“"]([^“”"]{20,}?)[”"]/g;

/** Every double-quoted run of 20+ chars, with where it sits in the text. */
function findQuotes(content) {
  const quotes = [];
  QUOTE_RE.lastIndex = 0;
  let m;
  while ((m = QUOTE_RE.exec(content || ""))) {
    quotes.push({ text: m[1], start: m.index, end: m.index + m[0].length });
  }
  return quotes;
}

// A quote's own citation is the first bracket that follows it before the next
// sentence ends — "…", he said [3]. — falling back to the last bracket before
// it, which is how a quote introduced as 'passage [3] says: "…"' attaches.
// Without this, fidelity checking asks the weaker question "does this text
// appear in ANY cited passage", which passes a quotation that is verbatim real
// but attributed to the wrong source. Verbatim-but-misattributed is not a
// lesser failure than invented: the reader who follows the number lands on
// bytes that do not contain the sentence they were shown.
const ATTACH_WINDOW = 120;

// A quote starting mid-sentence is conventionally capitalized when it opens a
// sentence in the answer, even though the source has it lowercase (and vice
// versa) — house style, not fabrication. Tolerating ONLY the first character's
// case, and only when the rest of the quote matches exactly, catches this
// without opening a general case-insensitive hole that would also swallow a
// genuinely invented capitalization change deeper in the quote (measured: a
// real CPU model — qwen2.5:0.5b-instruct — produced exactly this shape,
// quoting "The best season the orchard yielded…" for a source that reads
// "...in the best season the orchard yielded...", flagged unverified before
// this fix though every byte after the first was identical).
export function quoteOccursIn(haystackNorm, quoteNorm) {
  if (haystackNorm.includes(quoteNorm)) return true;
  if (!quoteNorm) return false;
  // The mechanical citator's proof clauses are the source's own bytes,
  // truncated to a display budget with an ellipsis — the "…" is not part of
  // the source, so exact-match fails. A quote that is a verbatim PREFIX of the
  // cited passage up to that marker IS the source's bytes: accept it.
  if (quoteNorm.endsWith("…")) {
    const prefix = quoteNorm.slice(0, -1).trimEnd();
    if (prefix.length >= 20 && haystackNorm.includes(prefix)) return true;
  }
  const first = quoteNorm[0];
  const flipped = first === first.toUpperCase() ? first.toLowerCase() : first.toUpperCase();
  if (flipped === first) return false; // not a letter — no case to flip
  return haystackNorm.includes(flipped + quoteNorm.slice(1));
}

function attachedNums(content, quote, refs) {
  // A sentence terminator ANYWHERE between the quote and the bracket means the
  // bracket belongs to a later sentence. Testing only the end of the gap let
  // '"…". A separate point follows [1].' read [1] as the quotation's citation
  // and report a misattribution the answer never made.
  const after = refs.find((r) => r.start >= quote.end && r.start - quote.end <= ATTACH_WINDOW &&
    !/[.!?]/.test(content.slice(quote.end, r.start)));
  if (after) return after.nums;
  const before = [...refs].reverse().find((r) => r.end <= quote.start && quote.start - r.end <= ATTACH_WINDOW);
  return before ? before.nums : [];
}

/**
 * Does every claimed verbatim quotation actually occur in the passage it cites?
 *
 * Three outcomes, kept distinct because they call for different reader action:
 *   verified      — present in a passage this quote actually cites
 *   misattributed — present in the corpus, but not in what it cites
 *   unverified    — present in no cited passage at all
 *
 * `unverified` retains its original shape and meaning for existing callers;
 * misattributed quotes are reported both in their own list and (as a finding
 * with a distinct `kind`) in checkGrounding's report.
 */
export function verifyQuotedFidelity(content, citations) {
  const quotes = findQuotes(content);
  if (!quotes.length) {
    return { quotesChecked: 0, verified: 0, unverified: [], misattributed: [] };
  }

  const refs = parseCitationRefs(content);
  const haystacks = (citations || []).map((c) => ({
    index: c.index,
    source_id: c.source_id,
    norm: normalizeForFidelity(c.text),
  }));

  const unverified = [];
  const misattributed = [];
  let verified = 0;
  for (const q of quotes) {
    const normQ = normalizeForFidelity(q.text);
    const nums = attachedNums(content, q, refs);
    const cited = nums.length ? haystacks.filter((h) => nums.includes(h.index)) : [];
    const clip = (s) => (s.length > 300 ? s.slice(0, 300) + "…" : s);

    // With no bracket attached there is nothing to be wrong *about* — fall
    // back to the whole table, the original behaviour, rather than inventing
    // a misattribution the answer never claimed.
    const pool = cited.length ? cited : haystacks;
    const hit = pool.find((c) => quoteOccursIn(c.norm, normQ));
    if (hit) { verified++; continue; }

    const elsewhere = cited.length ? haystacks.find((c) => quoteOccursIn(c.norm, normQ)) : null;
    if (elsewhere) {
      misattributed.push({
        quote: clip(q.text), start: q.start, end: q.end,
        citedNums: nums, actualIndex: elsewhere.index, actualSourceId: elsewhere.source_id,
      });
    } else {
      unverified.push({ quote: clip(q.text), start: q.start, end: q.end, citedNums: nums });
    }
  }
  return { quotesChecked: quotes.length, verified, unverified, misattributed };
}

// ── Unsupported claims: the void a valid bracket can still point into ────────
//
// The checks above catch a bracket with no passage behind it and a quotation
// with no bytes behind it. Neither catches the most common fabrication of all:
// an entirely well-formed [2] attached to a sentence whose content is nowhere
// in passage 2. The bracket resolves, nothing is quoted, and the claim reads as
// sourced.
//
// It is decidable, without a model, for the part of a claim that fabrication
// actually gets wrong: names, numbers, dates. A paraphrase legitimately
// reworks the wording of a passage; it does not legitimately introduce a
// proper noun or a figure the passage never contained. So each cited sentence
// is reduced to its **checkable atoms** — numerals and capitalised names — and
// every atom must occur in at least one of the passages that sentence cites.
//
// This is deliberately narrow. It says nothing about whether a paraphrase is
// faithful, and it will never flag a wrong claim made entirely in common words.
// What it does catch, it catches unarguably: the answer used a word or figure
// that does not appear anywhere in the bytes it pointed at.

// A capitalised word is only evidence of reference when the capital is not
// explained by grammar. English capitalises the first word of every sentence,
// so "Later he left [1]" and "Ingolstadt he left [1]" are identical in shape
// and only one of them names something.
//
// The first version resolved this by position: skip any single capitalised word
// at the start of a sentence. That is safe and blind — it silently exempts the
// most natural place in a sentence to put a fabricated name, which is exactly
// where a model puts one. Replaced with a declared table: a capitalised word is
// grammar if its lowercase form is an ordinary English word we have listed, and
// a reference otherwise, at any position. The table is inspectable and editable;
// a positional rule was neither.
//
// Erring toward listing is erring toward silence, so this stays deliberately
// tight: function words, the discourse adverbs that actually open sentences,
// and the vocabulary the app uses to talk about itself.
const CLAIM_STOPWORDS = new Set([
  // Determiners, pronouns, conjunctions, prepositions, auxiliaries.
  "the", "a", "an", "this", "that", "these", "those", "there", "here", "it", "its",
  "he", "she", "they", "them", "his", "her", "hers", "their", "theirs", "we", "us",
  "our", "ours", "you", "your", "yours", "i", "me", "my", "mine", "who", "whom",
  "whose", "which", "what", "where", "why", "how",
  "and", "but", "or", "nor", "so", "yet", "for", "as", "if", "then", "than", "when",
  "while", "after", "before", "since", "because", "although", "though", "unless",
  "until", "whether", "in", "on", "at", "by", "to", "from", "with", "within",
  "without", "of", "about", "into", "onto", "over", "under", "between", "among",
  "through", "during", "against", "toward", "towards", "upon", "across", "per",
  "is", "are", "was", "were", "be", "been", "being", "am", "has", "have", "had",
  "do", "does", "did", "will", "would", "shall", "should", "can", "could", "may",
  "might", "must", "let", "let's",
  // Quantifiers, degree, and the adverbs that open sentences.
  "no", "not", "yes", "both", "each", "every", "either", "neither", "some", "any",
  "all", "none", "few", "many", "much", "more", "most", "less", "least", "several",
  "one", "two", "three", "other", "another", "same", "such", "own", "very", "only",
  "just", "also", "too", "still", "already", "always", "never", "often", "again",
  "first", "second", "third", "next", "last", "later", "earlier", "now", "today",
  "however", "moreover", "therefore", "thus", "hence", "meanwhile", "instead",
  "overall", "finally", "additionally", "furthermore", "nevertheless", "besides",
  "accordingly", "consequently", "similarly", "conversely", "notably", "indeed",
  "perhaps", "maybe", "possibly", "likely", "clearly", "importantly", "generally",
  "specifically", "particularly", "essentially", "ultimately", "together",
  "according", "based", "note", "given", "regarding", "concerning", "despite",
  "yes", "well", "actually", "meanwhile", "otherwise",
  // The frame the answer speaks in — never a thing it refers to.
  "source", "sources", "passage", "passages", "text", "texts", "document",
  "documents", "answer", "answers", "question", "questions", "reader", "material",
  "context", "citation", "citations", "quote", "quotes", "summary", "response",
]);

/** Words of a passage, lowercased, punctuation stripped — the support index. */
function wordSet(s) {
  const set = new Set();
  // Unicode-aware: an ASCII-only split turns "café" into "caf" and "résumé"
  // into three fragments, so a passage in any language with diacritics stopped
  // supporting its own vocabulary.
  for (const w of String(s || "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w) set.add(w);
  }
  return set;
}

// Figures need their own index. Splitting a passage on non-alphanumerics turns
// "4,200" into the two tokens "4" and "200", so an answer correctly repeating
// "4,200" from its own cited passage found neither and was reported as an
// invented figure — a false accusation, which is worse than a miss: it teaches
// the reader to ignore the marker.
const NUM_IN_TEXT_RE = /\d[\d,]*(?:\.\d+)?/g;
function numberSet(s) {
  const set = new Set();
  const src = String(s || "");
  NUM_IN_TEXT_RE.lastIndex = 0;
  let m;
  while ((m = NUM_IN_TEXT_RE.exec(src)) !== null) {
    set.add(m[0].replace(/,/g, ""));
  }
  return set;
}

// Suffix tolerance in BOTH directions, so "Frankenstein's" matches
// "Frankenstein" and "creature" matches "creatures", without letting a
// three-letter prefix match half the corpus.
const MIN_STEM = 4;
function hasWord(index, word) {
  const w = word.toLowerCase();
  if (index.words.has(w)) return true;
  if (w.length < MIN_STEM) return false;
  for (const hw of index.words) {
    if (hw.length >= MIN_STEM && (hw.startsWith(w) || w.startsWith(hw))) return true;
  }
  return false;
}

// A figure is matched exactly, with commas normalised away on both sides. No
// stem tolerance: 4,200 and 42,000 are different claims, and a prefix match
// between them would be the checker inventing agreement.
function hasNumber(index, token) {
  return index.numbers.has(String(token).replace(/,/g, ""));
}

function supports(index, atomKind, token) {
  return atomKind === "number" ? hasNumber(index, token) : hasWord(index, token);
}

function buildIndex(citations) {
  const byIndex = new Map();
  for (const c of citations || []) {
    byIndex.set(c.index, {
      index: c.index, source_id: c.source_id,
      words: wordSet(c.text), numbers: numberSet(c.text),
    });
  }
  return byIndex;
}

// Sentence splitting that does not break on the abbreviations and initials
// that a source-grounded answer is full of ("Mrs. Saville", "vol. II", "p. 4").
const ABBREV = /(?:\b(?:mr|mrs|ms|dr|st|prof|rev|hon|vol|no|pp?|ch|ed|fig|cf|vs|etc|al|inc|ltd|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)|\b[A-Z])\.$/i;

// Shared by citation-check's own grounding checks and conversation-memory.js's
// stated-fact extraction — one sentence splitter, so "a sentence" means the
// same thing in the two places that have to agree about what a stated fact is.
export function splitSentences(text) {
  const out = [];
  const src = String(text || "");
  let start = 0;
  const re = /[.!?]+(?=["'”’)\]]*(?:\s|$))|\n{2,}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const end = m.index + m[0].length;
    const head = src.slice(start, end);
    if (ABBREV.test(head.trimEnd())) continue;
    if (head.trim()) out.push({ text: head, start, end });
    start = end;
  }
  if (start < src.length && src.slice(start).trim()) {
    out.push({ text: src.slice(start), start, end: src.length });
  }
  return out;
}

// Atoms are extracted from the sentence with its brackets blanked out, so a
// citation number is never mistaken for a claimed figure — the check would
// otherwise flag every "[3]" as an unsupported number 3.
function blankBrackets(sentence, absoluteStart) {
  let masked = sentence;
  for (const ref of parseCitationRefs(sentence)) {
    masked = masked.slice(0, ref.start) + " ".repeat(ref.end - ref.start) + masked.slice(ref.end);
  }
  return { masked, absoluteStart };
}

const NUMBER_RE = /\b\d[\d,]*(?:\.\d+)?%?\b/g;
// Unicode-aware for the same reason wordSet is, and more urgently: an
// ASCII-only [A-Z][A-Za-z]* matched "Zürich" as the single letter "Z", so
// annotateVoids inserted its marker in the middle of the word — a check that
// corrupts the text it is auditing.
const PROPER_RE = /\p{Lu}[\p{L}]*(?:['’][\p{L}]+)?(?:[ -](?:of|the|de|von|van|del|la|le)?[ ]?\p{Lu}[\p{L}]*(?:['’][\p{L}]+)?)*/gu;

function extractAtoms(masked, absoluteStart) {
  const atoms = [];

  NUMBER_RE.lastIndex = 0;
  let m;
  while ((m = NUMBER_RE.exec(masked)) !== null) {
    // A list marker ("1." at the head of a line) is layout, not a claim.
    const before = masked.slice(0, m.index);
    const atLineStart = /(^|\n)[\s>*-]*$/.test(before);
    const followedByMarker = /^[.)]\s/.test(masked.slice(m.index + m[0].length));
    if (atLineStart && followedByMarker) continue;
    atoms.push({
      kind: "number",
      text: m[0],
      tokens: [m[0].replace(/[,%]/g, "")],
      start: absoluteStart + m.index,
      end: absoluteStart + m.index + m[0].length,
    });
  }

  PROPER_RE.lastIndex = 0;
  while ((m = PROPER_RE.exec(masked)) !== null) {
    const phrase = m[0].trim();
    const words = phrase.split(/[\s-]+/).filter(Boolean);
    const contentWords = words.filter((w) => !CLAIM_STOPWORDS.has(w.toLowerCase().replace(/['’]s$/, "")));
    if (!contentWords.length) continue;

    atoms.push({
      kind: "name",
      text: phrase,
      tokens: contentWords.map((w) => w.replace(/['’]s$/, "")),
      start: absoluteStart + m.index,
      end: absoluteStart + m.index + m[0].length,
    });
  }

  atoms.sort((a, b) => a.start - b.start);
  return atoms;
}

// L3: a capped report reads as a complete one unless it says otherwise.
const MAX_FINDINGS = 60;

/**
 * The whole mechanical fact-check for one completed answer.
 *
 * @param {string} content  the model's answer, as the reader will see it
 * @param {{index:number,source_id?:string,text?:string}[]} citations  the engine's citation table
 * @param {{question?:string}} [opts]  the reader's question, so an atom the
 *        answer merely echoes back can be marked as such rather than read as
 *        a fabrication the model introduced
 *
 * @returns a report whose counters are always populated, so "nothing was
 *          wrong" and "nothing was checked" can never render identically
 *          (LAWS.md: two facts that differ must not read alike).
 */
export function checkGrounding(content, citations, opts = {}) {
  const table = (citations || []).map((c, i) => ({ ...c, index: c.index ?? i + 1 }));
  const maxCitation = table.length;
  const index = buildIndex(table);
  const questionWords = wordSet(opts.question || "");

  const refs = parseCitationRefs(content);
  const sentences = splitSentences(content);
  const fidelity = verifyQuotedFidelity(content, table);

  const findings = [];
  let atomsChecked = 0;
  let citedSentences = 0;

  for (const s of sentences) {
    const local = parseCitationRefs(s.text);
    if (!local.length) continue;
    citedSentences++;

    const nums = [...new Set(local.flatMap((r) => r.nums))];
    const valid = nums.filter((n) => index.has(n));
    if (!valid.length) continue; // every number invalid — already an unresolved_citation finding

    const { masked } = blankBrackets(s.text, s.start);
    const atoms = extractAtoms(masked, s.start);

    // A quoted run is checked verbatim by verifyQuotedFidelity; re-checking its
    // interior word by word would report the same defect twice under two names.
    const quoteSpans = findQuotes(s.text).map((q) => [s.start + q.start, s.start + q.end]);
    const inQuote = (a) => quoteSpans.some(([qs, qe]) => a.start >= qs && a.end <= qe);

    for (const atom of atoms) {
      if (inQuote(atom)) continue;
      atomsChecked++;
      const supporting = [];
      const absent = [];
      for (const token of atom.tokens) {
        const where = valid.filter((n) => supports(index.get(n), atom.kind, token));
        if (where.length) supporting.push(...where);
        else absent.push(token);
      }
      if (!absent.length) continue;

      const elsewhere = [...index.keys()].filter(
        (n) => !valid.includes(n) && absent.every((t) => supports(index.get(n), atom.kind, t)),
      );
      findings.push({
        kind: elsewhere.length ? "misattributed_claim" : "unsupported_claim",
        atomKind: atom.kind,
        text: atom.text,
        absent,
        citedNums: valid,
        foundIn: elsewhere,
        start: atom.start,
        end: atom.end,
        // Not an excuse and not a filter — the reader asked about "1815", so
        // an unsupported "1815" may be the answer restating the question
        // rather than inventing a date. Flagged so a client can rank it lower,
        // never dropped, because "your sources do not say this" is exactly the
        // finding that matters when the reader supplied the premise.
        echoesQuestion: atom.tokens.every((t) => questionWords.has(t.toLowerCase())),
      });
    }
  }

  for (const u of fidelity.unverified) {
    findings.push({
      kind: "unverified_quote", atomKind: "quote", text: u.quote,
      absent: [], citedNums: u.citedNums || [], foundIn: [],
      start: u.start, end: u.end, echoesQuestion: false,
    });
  }
  for (const m of fidelity.misattributed) {
    findings.push({
      kind: "misattributed_quote", atomKind: "quote", text: m.quote,
      absent: [], citedNums: m.citedNums || [], foundIn: [m.actualIndex],
      start: m.start, end: m.end, echoesQuestion: false,
    });
  }

  const unresolvedNums = [...new Set(refs.flatMap((r) => r.nums))]
    .filter((n) => !index.has(n))
    .sort((a, b) => a - b);

  findings.sort((a, b) => a.start - b.start);
  const total = findings.length;
  const kept = findings.slice(0, MAX_FINDINGS);

  return {
    // What was examined — reported unconditionally, because a report with no
    // findings must state whether it looked.
    sentences: sentences.length,
    citedSentences,
    uncitedSentences: sentences.length - citedSentences,
    citationTableSize: maxCitation,
    bracketsFound: refs.length,
    atomsChecked,
    quotesChecked: fidelity.quotesChecked,
    quotesVerified: fidelity.verified,
    // What was wrong.
    unresolvedNums,
    findings: kept,
    truncated: total > kept.length ? { reported: kept.length, total, dropped: total - kept.length } : null,
    // One number a client can render without interpreting the list.
    clean: total === 0 && unresolvedNums.length === 0,
  };
}

const VOID_MARKER = {
  unsupported_claim: (f) => `[⊘ not in ${f.citedNums.length === 1 ? "source " + f.citedNums[0] : "sources " + f.citedNums.join(", ")}]`,
  misattributed_claim: (f) => `[⊘ not in ${f.citedNums.join(", ")} — appears in ${f.foundIn.join(", ")}]`,
  unverified_quote: () => `[⊘ not a verbatim quote from any cited source]`,
  misattributed_quote: (f) => `[⊘ verbatim in source ${f.foundIn.join(", ")}, not ${f.citedNums.join(", ")}]`,
};

/**
 * Write the void into the answer itself.
 *
 * The findings alone satisfy an auditor; they do not satisfy L2b, which asks
 * that the route to the doubt begin at the artifact rather than at a panel the
 * reader must know to open. An unsupported name reads as sourced prose right
 * up until someone goes looking. Marking it in place costs one bracket and
 * removes the need to already be suspicious.
 *
 * Applied right to left so every finding's offsets stay valid as the string
 * grows. Never removes or rewrites the model's own words — the marker is
 * additive, so the answer remains readable as written and the reader can see
 * exactly which span the machine could not stand behind.
 */
export function annotateVoids(content, report) {
  if (!content || !report || !report.findings?.length) return content;
  let out = content;
  for (const f of [...report.findings].sort((a, b) => b.start - a.start)) {
    const marker = VOID_MARKER[f.kind];
    if (!marker || f.end == null) continue;
    out = out.slice(0, f.end) + marker(f) + out.slice(f.end);
  }
  return out;
}

/** The report as the typed gaps the rest of the app already speaks in. */
export function groundingGaps(report) {
  const gaps = [];
  if (!report) return gaps;
  if (report.unresolvedNums.length) {
    gaps.push({
      type: "unresolved_citation",
      nums: report.unresolvedNums.map(String),
      reason: `[${report.unresolvedNums.join("], [")}] — no engine passage matches this bracket.`,
    });
  }
  for (const f of report.findings) {
    if (f.kind === "unverified_quote") {
      gaps.push({ type: "unverified_quote", quote: f.text, reason: "This quoted text does not appear verbatim in any cited passage." });
    } else if (f.kind === "misattributed_quote") {
      gaps.push({ type: "misattributed_quote", quote: f.text, citedNums: f.citedNums, foundIn: f.foundIn, reason: `This quotation is verbatim in passage [${f.foundIn.join("], [")}], not the [${f.citedNums.join("], [")}] it cites.` });
    } else if (f.kind === "misattributed_claim") {
      gaps.push({ type: "misattributed_claim", claim: f.text, absent: f.absent, citedNums: f.citedNums, foundIn: f.foundIn, reason: `"${f.text}" does not appear in passage [${f.citedNums.join("], [")}]; it appears in [${f.foundIn.join("], [")}].` });
    } else if (f.kind === "unsupported_claim") {
      gaps.push({ type: "unsupported_claim", claim: f.text, absent: f.absent, citedNums: f.citedNums, echoesQuestion: f.echoesQuestion, reason: `"${f.text}" appears in no passage this sentence cites ([${f.citedNums.join("], [")}]) — ${f.absent.length === 1 ? `"${f.absent[0]}" occurs` : `"${f.absent.join('", "')}" occur`} nowhere in those bytes.` });
    }
  }
  if (report.truncated) {
    gaps.push({
      type: "findings_truncated",
      reason: `${report.truncated.total} grounding findings were made; ${report.truncated.reported} are shown and ${report.truncated.dropped} were dropped.`,
    });
  }
  return gaps;
}

// ── Mechanical citation attachment ──────────────────────────────────────────
//
// A citation the model chooses to write is still the model's choice — it can
// simply forget, especially a small model, and the reader has no way to tell
// "this came from a source" from "this came from parametric memory" apart.
// This runs after generation, blind to what the model intended, and decides
// two things purely by string matching: whether an uncited sentence's own
// vocabulary is concentrated enough in ONE source to name it, and if so,
// which few words of that source's own text to splice in as proof — a literal
// verbatim clause, not a paraphrase, so the reader is looking at the source's
// own bytes rather than trusting the match that found them.
//
// Conservative on purpose: most uncited sentences get nothing, because most
// don't concentrate enough shared vocabulary in a single source to name one
// without guessing. Silence is the correct output there — better an
// unattributed sentence than a confidently wrong attribution.

const AUTO_CITE_MIN_SIGNIFICANT_WORDS = 4;
const AUTO_CITE_MIN_SCORE = 0.6;
const AUTO_CITE_MIN_HITS = 3;
const AUTO_CITE_QUOTE_MAX_CHARS = 110;
const AUTO_CITE_MIN_SOURCE_CHARS = 40;

function significantWords(s) {
  const set = new Set();
  for (const w of String(s || "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length >= 4 && !CLAIM_STOPWORDS.has(w)) set.add(w);
  }
  return set;
}

// The clause of `sourceText` (split on sentence-ish boundaries) whose own
// vocabulary overlaps `wordsWanted` the most — the actual bytes shown as
// proof, not a description of them. Trimmed to a word boundary, never
// mid-word, when it runs past the display budget.
function bestClause(sourceText, wordsWanted) {
  const clauses = String(sourceText || "").split(/(?<=[.!?;])\s+/).map((c) => c.trim()).filter(Boolean);
  let best = null, bestHits = 0;
  for (const c of clauses) {
    if (c.length < 20) continue;
    const cWords = significantWords(c);
    if (!cWords.size) continue;
    let hits = 0;
    for (const w of wordsWanted) if (cWords.has(w)) hits++;
    if (hits > bestHits) { bestHits = hits; best = c; }
  }
  if (!best) return null;
  if (best.length <= AUTO_CITE_QUOTE_MAX_CHARS) return best;
  const cut = best.slice(0, AUTO_CITE_QUOTE_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut) + "…";
}

// Where, within one sentence's own text, a splice belongs: right before the
// sentence's closing punctuation, not after it — "...ends here (\"quote\"
// [2])." reads as one sentence; appending after the period reads as a stray
// fragment tacked onto the next one.
function insertionPointWithinSentence(sentenceText) {
  const m = sentenceText.match(/[.!?]+["'”’)\]]*\s*$/);
  return m ? sentenceText.length - m[0].length : sentenceText.length;
}

/**
 * Attach a citation — bracket plus a short verbatim clause as proof — to any
 * sentence the model left uncited, when that sentence's vocabulary is
 * concentrated enough in one source's text to name it without guessing.
 * Nothing here is invented: the clause is a literal substring of the citation
 * table entry the bracket points to, and the same downstream mechanical
 * checks (verifyQuotedFidelity, checkGrounding) run against it exactly as
 * they would against a quote the model wrote itself.
 */
export function autoAttachCitations(text, citations) {
  if (!text || !citations || !citations.length) return text;
  const sentences = splitSentences(text);
  if (!sentences.length) return text;

  const sources = citations
    .map((c) => ({ index: c.index, text: String(c.text || ""), words: significantWords(c.text) }))
    .filter((s) => s.text.length >= AUTO_CITE_MIN_SOURCE_CHARS && s.words.size >= AUTO_CITE_MIN_SIGNIFICANT_WORDS);
  if (!sources.length) return text;

  const inserts = [];
  for (const s of sentences) {
    if (parseCitationRefs(s.text).length) continue; // the model already cited this one
    const words = significantWords(s.text);
    if (words.size < AUTO_CITE_MIN_SIGNIFICANT_WORDS) continue;

    let best = null, bestScore = 0, bestHits = 0;
    for (const src of sources) {
      let hits = 0;
      for (const w of words) if (src.words.has(w)) hits++;
      const score = hits / words.size;
      if (score > bestScore) { bestScore = score; bestHits = hits; best = src; }
    }
    if (!best || bestScore < AUTO_CITE_MIN_SCORE || bestHits < AUTO_CITE_MIN_HITS) continue;

    const clause = bestClause(best.text, words);
    const at = s.start + insertionPointWithinSentence(s.text);
    inserts.push({ at, num: best.index, clause });
  }
  if (!inserts.length) return text;

  let out = text;
  for (const ins of [...inserts].sort((a, b) => b.at - a.at)) {
    const addition = ins.clause ? ` ("${ins.clause}" [${ins.num}])` : ` [${ins.num}]`;
    out = out.slice(0, ins.at) + addition + out.slice(ins.at);
  }
  return out;
}
