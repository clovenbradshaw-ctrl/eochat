import { readFileSync } from "node:fs";
import { stripContainer } from "../../eoreader6/packages/engine/perceiver/text/spans.js";
const text = readFileSync("/Users/mlacy/Documents/Default Project/pg84.txt", "utf8");
const body = stripContainer(text).text;
const bytes = new TextEncoder().encode(body);
const find = (needle) => {
  const idx = body.indexOf(needle);
  if (idx < 0) return -1;
  return bytes.subarray(0, idx).length;
};
for (const [label, needle] of [
  ["rushed out of the room", "rushed out of the room"],
  ["university of Ingolstadt", "university of Ingolstadt"],
  ["become a student at the university of Ingolstadt", "become a student at the university of Ingolstadt"],
  ["Natural philosophy", "Natural philosophy"],
  ["genius that has regulated my fate", "genius that has regulated my fate"],
]) {
  console.log(`${label.padEnd(55)} -> body byte ${find(needle)}`);
}
