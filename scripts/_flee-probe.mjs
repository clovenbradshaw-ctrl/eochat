import { createSession, admitChunked, searchSpans } from "@eoreader/host/corpus";
import { readFileSync } from "node:fs";

const text = readFileSync("/Users/mlacy/Documents/Default Project/pg84.txt", "utf8");
const session = createSession({});
admitChunked(session, { text, sourceId: "source:pg84.txt" });

const QUERIES = [
  "why did the narrator flee from the creature",
  "why did he flee from the creature",
  "where did victor go to school",
  "what did victor study at university",
];

for (const q of QUERIES) {
  const { spans, gaps } = searchSpans(session, { query: q, limit: 5 });
  console.log(`\n=== "${q}" ===`);
  if (!spans.length) {
    console.log("  (no spans)");
    continue;
  }
  for (const s of spans.slice(0, 5)) {
    const snippet = (s.text || "").replace(/\s+/g, " ").slice(0, 130);
    console.log(`  score=${s.score?.toFixed(3)} phrase=${s.phrase_score?.toFixed(3)} byte=${s.byte_start} :: ${snippet}`);
  }
}
