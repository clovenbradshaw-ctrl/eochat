import fs from "node:fs";
import { stripContainer } from "../../eoreader6/packages/engine/perceiver/text/spans.js";
import { properNounsOf } from "../../eoreader6/packages/engine/perceiver/text/proper.js";
const raw = fs.readFileSync(process.argv[2], "utf8");
const body = stripContainer(raw).text || raw;
const { names, observations } = properNounsOf(body);
const set = names instanceof Set ? names : new Set(names);
console.log("observations", observations, "names", set.size);
for (const w of ["part","locke","hume","god","descartes","plato","whitehead","newton","kant","professor","cambridge","macmillan","sect","section","contents","category","order","nature","form","aristotle","santayana","spinoza","timaeus","scholium","cartesian"])
  console.log(" ", (set.has(w)?"NAME ":"  no "), w);
