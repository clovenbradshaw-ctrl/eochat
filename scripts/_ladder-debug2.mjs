import { readFileSync } from "node:fs";
import { splitSentences } from "/Users/mlacy/Documents/2.0/eoreader6/packages/engine/perceiver/text/spans.js";
import { extractRelations } from "/Users/mlacy/Documents/2.0/eoreader6/packages/engine/perceiver/text/relations.js";
import { extractSurfaces, discoverReferents } from "/Users/mlacy/Documents/2.0/eoreader6/packages/engine/perceiver/text/surfaces.js";
import { tokenize, buildFrequencyTable, functionWordSet } from "/Users/mlacy/Documents/2.0/eoreader6/packages/engine/perceiver/text/material.js";

const text = readFileSync("/Users/mlacy/Documents/Default Project/pg84.txt", "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
const sentences = splitSentences(text);
const frames = [];
for (let i = 0; i < sentences.length; i += 6) {
  const g = sentences.slice(i, i + 6);
  if (g.length) frames.push({ order: frames.length, offset: g[0].offset, text: g.map((s) => s.text).join(" ") });
}
const table = buildFrequencyTable(tokenize(text));
const functionWords = functionWordSet(table);
const surfaces = extractSurfaces(sentences, { functionWords });

const countWord = (t) => t.toLowerCase();
const measure = (t) => { const w = countWord(t); return functionWords.has(w) ? { w, n: 1 } : null; };

const vocabA = new Set();
const vocabB = new Set();
let admittedA = new Map(), admittedB = new Map();
for (const f of frames) {
  const sent = sentences.filter(s => s.offset >= f.offset && s.offset < f.offset + f.text.length);
  const sM = sent.map(measure).filter(Boolean);
  for (const { w } of sM) { if (!vocabA.has(w)) { vocabA.add(w); admittedA.set(w, f.order); } }
  const names = sent.filter(s => /[A-Z]/.test(s.text[0]));
  if (names.length) {
    const nM = names.map(measure).filter(Boolean);
    for (const { w } of nM) { if (!vocabB.has(w)) { vocabB.add(w); admittedB.set(w, f.order); } }
  }
}
for (const w of ["should", "is", "arrived", "became", "saw"]) {
  console.log(`${w.padEnd(8)} A@frame ${String(admittedA.get(w)).padEnd(5)} B@frame ${String(admittedB.get(w))}`);
}
console.log(`vocabA ${vocabA.size}  vocabB ${vocabB.size}`);
console.log(`school frame 71 -> should admitted by B? ${admittedB.get("should") <= 71}`);
console.log(`study frame 63 -> is admitted by B? ${admittedB.get("is") <= 63}`);
