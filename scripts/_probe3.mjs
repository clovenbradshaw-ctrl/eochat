import fs from "node:fs";
import { splitSentences, deriveAbbreviations, stripContainer } from "../../eoreader6/packages/engine/perceiver/text/spans.js";
import { tokenize, buildFrequencyTable, functionWordSet } from "../../eoreader6/packages/engine/perceiver/text/material.js";
import { extractSurfaces, discoverReferents, diaNorm } from "../../eoreader6/packages/engine/perceiver/text/surfaces.js";
import { projectReferents } from "../../eoreader6/packages/engine/referents/index.js";

const ROMAN = /^M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;
const isRoman = (s) => s.length > 0 && s === s.toUpperCase() && ROMAN.test(s);
const stripPoss = (s) => s.replace(/['’]s?$/i, "");
const allCaps = (s) => { const l = s.replace(/[^\p{L}]/gu, ""); return l.length > 0 && l === l.toUpperCase(); };

const raw = fs.readFileSync(process.argv[2], "utf8");
const body = stripContainer(raw).text || raw;
const abbrev = deriveAbbreviations(body);
console.log("derived abbreviations:", [...abbrev].join(" "));
const all = splitSentences(body, { abbreviations: abbrev });
const sentences = all.filter(s => !allCaps(s.text));
console.log("sentences", all.length, "-> after dropping all-caps headings", sentences.length);
const fw = functionWordSet(buildFrequencyTable(tokenize(body)));
let surfaces = extractSurfaces(sentences, { functionWords: fw });
console.log("surfaces raw", surfaces.length);

const before = surfaces.length;
surfaces = surfaces.filter(s => {
  const toks = s.surface.split(/\s+/);
  if (toks.every(isRoman)) return false;
  if (toks.length > 1 && toks.every(allCaps)) return false;
  if (toks.length === 1 && abbrev.has(toks[0])) return false;
  if (stripPoss(s.surface).replace(/[^\p{L}\p{N}]/gu, "").length < 2) return false;
  return true;
});
console.log("surfaces after roman/abbrev/short", surfaces.length, `(-${before - surfaces.length})`);

// possessive merge: fold "Locke's" counts into "Locke"
const merged = new Map();
for (const s of surfaces) {
  let toks = s.surface.split(/\s+/).map(stripPoss);
  while (toks.length > 1 && isRoman(toks[toks.length - 1])) toks.pop();
  const key = toks.join(" ");
  const prev = merged.get(diaNorm(key));
  if (prev) { prev.mentions += s.mentions; prev.sentences += s.sentences; prev.variants.push(s.surface); }
  else merged.set(diaNorm(key), { surface: key, mentions: s.mentions, sentences: s.sentences, variants: [s.surface] });
}
surfaces = [...merged.values()].sort((a,b)=>b.mentions-a.mentions);
console.log("surfaces after possessive merge", surfaces.length);

const { events } = discoverReferents(surfaces);
const refs = projectReferents(events);
const counts = new Map(surfaces.map(s => [s.surface, s.mentions]));
const scored = refs.map(r => ({ surfaces: r.surfaces, m: r.surfaces.reduce((a,s)=>a+(counts.get(s)||0),0) })).sort((a,b)=>b.m-a.m);
console.log("referents", refs.length, "\n--- top 30 ---");
for (const r of scored.slice(0, 30)) console.log(`  ${String(r.m).padStart(4)}  ${JSON.stringify(r.surfaces).slice(0,80)}`);
