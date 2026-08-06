import { readFileSync } from "node:fs";
const text = readFileSync("/Users/mlacy/Documents/Default Project/pg84.txt", "utf8");
const bytes = new TextEncoder().encode(text);
const find = (needle) => {
  const idx = text.indexOf(needle);
  if (idx < 0) return -1;
  return bytes.subarray(0, idx).length;
};
for (const [label, needle] of [
  ["rushed out of the room", "rushed out of the room"],
  ["I rushed out of the room", "I rushed out of the room"],
  ["become a student at the university of Ingolstadt", "become a student at the university of Ingolstadt"],
  ["university of Ingolstadt", "university of Ingolstadt"],
  ["Natural philosophy", "Natural philosophy"],
  ["genius that has regulated my fate", "genius that has regulated my fate"],
]) {
  console.log(`${label.padEnd(55)} -> byte ${find(needle)}`);
}
