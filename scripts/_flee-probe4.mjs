import { readFileSync } from "node:fs";
const text = readFileSync("/Users/mlacy/Documents/Default Project/pg84.txt", "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
const bytes = new TextEncoder().encode(text);
const find = (needle, from = 0) => {
  const idx = text.indexOf(needle, from);
  if (idx < 0) return -1;
  return bytes.subarray(0, idx).length;
};
for (const [label, needle] of [
  ["rushed out of the room", "rushed out of the room"],
  ["become a student at the university of Ingolstadt", "become a student at the university of Ingolstadt"],
  ["university of Ingolstadt", "university of Ingolstadt"],
  ["Natural philosophy", "Natural philosophy"],
  ["genius that has regulated my fate", "genius that has regulated my fate"],
  ["spark of being", "spark of being"],
  ["create a female", "create a female"],
]) {
  console.log(`${label.padEnd(50)} -> byte ${find(needle)}`);
}
console.log("total bytes:", bytes.length);
