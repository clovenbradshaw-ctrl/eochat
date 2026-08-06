import { readFileSync } from "node:fs";
import { splitSentences } from "/Users/mlacy/Documents/2.0/eoreader6/packages/engine/perceiver/text/spans.js";
import { extractRelations, discoverRelationVocab } from "/Users/mlacy/Documents/2.0/eoreader6/packages/engine/perceiver/text/relations.js";
import { extractSurfaces, discoverReferents } from "/Users/mlacy/Documents/2.0/eoreader6/packages/engine/perceiver/text/surfaces.js";
import { tokenize, buildFrequencyTable, functionWordSet } from "/Users/mlacy/Documents/2.0/eoreader6/packages/engine/perceiver/text/material.js";
import { projectReferents } from "/Users/mlacy/Documents/2.0/eoreader6/packages/engine/referents/index.js";

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
const { verbs } = discoverRelationVocab(text, { surfaces, functionWords, minSurfaces: 1 });

const atByte = (b) => frames.findIndex((f) => { const n = f.offset; const fr = frames[frames.indexOf(f)+1]; return b >= n && (!fr || b < fr.offset); });
for (const [label, b] of [["school", 55560], ["study", 48010], ["flee", 86787]]) {
  const fi = atByte(b);
  console.log(`\n=== ${label} byte ${b} -> frame ${fi} (offset ${frames[fi]?.offset}) ===`);
  console.log(`  verb "should" in whole-text vocab: ${verbs.has("should")}`);
  const raw = extractRelations(frames[fi]?.text ?? "", { verbs });
  for (const r of raw) {
    const sub = text.indexOf(r.subject, frames[fi].offset);
    const obj = text.indexOf(r.object, frames[fi].offset);
    const hits = (b >= sub && b < sub + r.subject.length) || (b >= obj && b < obj + r.object.length);
    console.log(`  [${r.subject}] ${r.verb} [${r.object.slice(0,45)}]  sub=${sub} obj=${obj} covers? ${hits}`);
  }
  if (!raw.length) console.log("  (no relations in this frame under whole-text vocab)");
}
