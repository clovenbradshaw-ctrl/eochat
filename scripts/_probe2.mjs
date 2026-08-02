import fs from "node:fs";
import { splitSentences, deriveAbbreviations, stripContainer } from "../../eoreader6/packages/engine/perceiver/text/spans.js";
import { tokenize, buildFrequencyTable, functionWordSet } from "../../eoreader6/packages/engine/perceiver/text/material.js";
import { extractSurfaces, discoverReferents, genericTokens, diaNorm } from "../../eoreader6/packages/engine/perceiver/text/surfaces.js";
import { projectReferents } from "../../eoreader6/packages/engine/referents/index.js";

const raw = fs.readFileSync(process.argv[2], "utf8");
const body = stripContainer(raw).text || raw;
const sentences = splitSentences(body, { abbreviations: deriveAbbreviations(body) });
const fw = functionWordSet(buildFrequencyTable(tokenize(body)));
let surfaces = extractSurfaces(sentences, { functionWords: fw });
console.log("sentences", sentences.length, "surfaces", surfaces.length);
const generic = genericTokens(surfaces);
console.log("genericTokens:", [...generic].slice(0,40).join(" "));
const { events } = discoverReferents(surfaces);
const refs = projectReferents(events);
console.log("referents", refs.length);
const counts = new Map(surfaces.map(s => [s.surface, s.mentions]));
const scored = refs.map(r => ({ id: r.id, surfaces: r.surfaces, m: r.surfaces.reduce((a,s)=>a+(counts.get(s)||0),0) })).sort((a,b)=>b.m-a.m);
for (const r of scored.slice(0, 40)) {
  const toks = diaNorm(r.surfaces[0]).split(/\s+/).filter(t=>t.length>2);
  const allGeneric = toks.length > 0 && toks.every(t => generic.has(t));
  console.log(`  ${String(r.m).padStart(4)}  ${allGeneric?'GEN ':'    '} ${JSON.stringify(r.surfaces).slice(0,90)}`);
}
