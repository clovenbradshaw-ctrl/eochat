import fs from "node:fs";
import { createSession, admitChunked, sessionReferents } from "@eoreader/host";
for (const path of process.argv.slice(2)) {
  const text = fs.readFileSync(path, "utf8");
  const session = createSession();
  const sourceId = `source:${path}`;
  const t0 = Date.now();
  admitChunked(session, { text, sourceId });
  const out = sessionReferents(session, { sourceId, priors: [], limit: 16 });
  console.log(`\n=== ${path.split("/").pop()} (${(text.length/1024|0)}KB, ${Date.now()-t0}ms) ===`);
  console.log(out.referents.map(r => `${r.display}(${r.mentions})`).join("  "));
}
