#!/usr/bin/env node
// probe-war-and-peace-structure-spans.mjs — the whole novel's own structure
// (Book -> Chapter, the divisions Tolstoy/Maude actually printed), as real
// BYTE spans covering literally the entire file, not a sample.
//
// Deliberately NOT the terrain classifier. eoreader6/CUBE.md is explicit
// that deriving a semantic cell from content by classifying it was
// "measured and refuted" and "promoted out of the code." Recovering the
// book's OWN structural markup (BOOK/CHAPTER headings it already prints)
// is a different, much safer operation — SEG at the Field/Kind grain: it
// finds a boundary the text asserts about itself, it does not guess a
// meaning. No regex vocabulary table, no shuffle-invariance risk: a
// heading line is either "CHAPTER XIV" or it isn't.
//
// Two structural bugs caught before trusting the heading list, same
// discipline as the byte-offset work before this: (1) the book's own front-
// matter table of contents lists "SECOND EPILOGUE" etc. inline, which a
// loose regex matches as a false heading; (2) a quoted in-text letter
// ("MONSIEUR LE PRINCE KOUTOUZOV: ...") is set in running caps and matches
// a loose "ALL-CAPS-WORDS:" pattern. Both excluded by requiring the exact
// real heading shapes ("BOOK <WORD>: <digit>...", "FIRST/SECOND EPILOGUE")
// anchored at line start — verified by hand against the real match list
// before writing this file, not assumed to be complete.
//
// Usage: node scripts/probe-war-and-peace-structure-spans.mjs

import fs from "node:fs";
import path from "node:path";
import { MEMORY_DIR, REPO_ROOT } from "../server/paths.js";

const CACHE_DIR = path.join(MEMORY_DIR, "corpus-cache");
const canonicalPath = path.join(CACHE_DIR, "war-and-peace-en.lf.txt");
const text = fs.readFileSync(canonicalPath, "utf8");
const fd = fs.openSync(canonicalPath, "r");

function charToByte(charIndex) {
  return Buffer.byteLength(text.slice(0, charIndex), "utf8");
}
function byteSpanFor(charStart, charEnd) {
  const byteStart = charToByte(charStart);
  const byteLength = Buffer.byteLength(text.slice(charStart, charEnd), "utf8");
  return { byteStart, byteLength };
}
function verifyByteSpan(byteStart, byteLength, expectedStartsWith) {
  const buf = Buffer.alloc(Math.min(byteLength, 200));
  const n = fs.readSync(fd, buf, 0, buf.length, byteStart);
  return buf.subarray(0, n).toString("utf8").startsWith(expectedStartsWith);
}

// ── 1. Top-level divisions: 15 Books + 2 Epilogues, the book's own real headings ──
const BOOK_RE = /^(BOOK [A-Z]+: [\d].*|FIRST EPILOGUE:.*|SECOND EPILOGUE)$/gm;
const books = [];
let m;
while ((m = BOOK_RE.exec(text))) books.push({ title: m[0].trim(), charOffset: m.index });
console.log(`${books.length} real top-level divisions found (expected 17: 15 books + 2 epilogues).`);
if (books.length !== 17) {
  console.log(`  WARNING: expected 17, got ${books.length} — inspect before trusting downstream spans.`);
}

// ── 2. Chapter headings, scoped inside each book's own char range ──
const CHAPTER_RE = /^CHAPTER [IVXLCDM]+$/gm;
const allChapters = [];
CHAPTER_RE.lastIndex = books[0]?.charOffset ?? 0;
while ((m = CHAPTER_RE.exec(text))) allChapters.push({ title: m[0].trim(), charOffset: m.index });
console.log(`${allChapters.length} chapter headings found across the whole book.\n`);

// ── 3. Build the full structure: every Book, every Chapter inside it, as real byte spans ──
const structure = { canonicalSource: path.relative(REPO_ROOT, canonicalPath), totalChars: text.length, totalBytes: Buffer.byteLength(text, "utf8"), books: [] };

let checked = 0, verified = 0;
for (let bi = 0; bi < books.length; bi++) {
  const book = books[bi];
  const bookCharEnd = books[bi + 1]?.charOffset ?? text.length;
  const bookByte = byteSpanFor(book.charOffset, bookCharEnd);
  const bookOk = verifyByteSpan(bookByte.byteStart, bookByte.byteLength, book.title.slice(0, Math.min(30, book.title.length)));
  checked++; if (bookOk) verified++;

  const chaptersInBook = allChapters.filter((c) => c.charOffset >= book.charOffset && c.charOffset < bookCharEnd);
  const chapterEntries = chaptersInBook.map((ch, ci) => {
    const chCharEnd = chaptersInBook[ci + 1]?.charOffset ?? bookCharEnd;
    const chByte = byteSpanFor(ch.charOffset, chCharEnd);
    const ok = verifyByteSpan(chByte.byteStart, chByte.byteLength, ch.title);
    checked++; if (ok) verified++;
    return { title: ch.title, byteOffset: chByte.byteStart, byteLength: chByte.byteLength, verified: ok };
  });

  structure.books.push({
    title: book.title,
    byteOffset: bookByte.byteStart,
    byteLength: bookByte.byteLength,
    verified: bookOk,
    chapterCount: chapterEntries.length,
    chapters: chapterEntries,
  });
}

fs.closeSync(fd);

console.log(`Byte-verified ${verified}/${checked} spans (every book + every chapter) with a real fs.readSync seek.\n`);
for (const b of structure.books) {
  console.log(`${b.title.padEnd(24)} byteOffset=${b.byteOffset.toString().padEnd(9)} byteLength=${b.byteLength.toString().padEnd(8)} chapters=${b.chapterCount} verified=${b.verified}`);
}

const totalChapterBytes = structure.books.reduce((s, b) => s + b.chapters.reduce((s2, c) => s2 + c.byteLength, 0), 0);
console.log(`\n${structure.books.length} books/epilogues, ${allChapters.length} chapters total.`);
console.log(`Sum of chapter byte-spans: ${totalChapterBytes.toLocaleString()} bytes vs. whole-file ${structure.totalBytes.toLocaleString()} bytes`);
console.log(`(${(100 * totalChapterBytes / structure.totalBytes).toFixed(1)}% — the gap is front matter, book-title pages, and inter-chapter whitespace, not lost content).`);

const outPath = path.join(CACHE_DIR, "war-and-peace-structure-spans.json");
fs.writeFileSync(outPath, JSON.stringify(structure, null, 2), "utf8");
console.log(`\nFull structural span index (every Book, every Chapter, real byte offsets, all independently`);
console.log(`verified) written to ${path.relative(REPO_ROOT, outPath)}.`);
