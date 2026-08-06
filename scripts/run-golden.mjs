#!/usr/bin/env node
// run-golden.mjs — Ingest a corpus, run deliberate longform pipeline with
// a real Ollama model, and write the result.
// Usage: node scripts/run-golden.mjs
import fs from "node:fs";
import { engineGroundQuery, engineIngestText } from "../server/engine-ground.js";
import { runDeliberateAnswer } from "../server/longform-orchestrator.js";
import { loadMorphologyPrior, discoverNarratorContext } from "../server/longform-node-context.js";

const MODEL = "llama3.2:latest";
const OLLAMA = process.env.OLLAMA || "http://localhost:11434";
const POOL = "golden-run";
const OUT = "essay-golden.md";

async function say(system, user, maxTokens = 260) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL, stream: false,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      options: { temperature: 0.4, num_ctx: 8192, num_predict: maxTokens },
    }),
    signal: AbortSignal.timeout(180000),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error);
  return (d.message?.content || "").trim();
}

// ── corpus: Letter 1 from Frankenstein (~4,500 chars of narrative prose) ──
const corpus = [
  "Letter 1. To Mrs. Saville, England. St. Petersburgh, Dec. 11th, 17—.",
  "You will rejoice to hear that no disaster has accompanied the commencement of an enterprise",
  "which you have regarded with such evil forebodings. I arrived here yesterday, and my first task",
  "is to assure my dear sister of my welfare and increasing confidence in the success of my undertaking.",
  "I am already far north of London, and as I walk in the streets of Petersburgh, I feel a cold",
  "northern breeze play upon my cheeks, which braces my nerves and fills me with delight.",
  "Do you understand this feeling? This breeze, which has travelled from the regions towards which",
  "I am advancing, gives me a foretaste of those icy climes. Inspirited by this wind of promise,",
  "my daydreams become more fervent and vivid. I try in vain to be persuaded that the pole is the",
  "seat of frost and desolation; it ever presents itself to my imagination as the region of beauty",
  "and delight. There, Margaret, the sun is for ever visible, its broad disk just skirting the",
  "horizon and diffusing a perpetual splendour. There — for with your leave, my sister, I will",
  "put some trust in preceding navigators — there snow and frost are banished; and, sailing over",
  "a calm sea, we may be wafted to a land surpassing in wonders and in beauty every region hitherto",
  "discovered on the habitable globe. Its productions and features may be without example,",
  "as the phenomena of the heavenly bodies undoubtedly are in those undiscovered solitudes.",
  "What may not be expected in a country of eternal light? I may there discover the wondrous power",
  "which attracts the needle and may regulate a thousand celestial observations that require only",
  "this voyage to render their seeming eccentricities consistent for ever. I shall satiate my",
  "ardent curiosity with the sight of a part of the world never before visited, and may tread",
  "a land never before imprinted by the foot of man. These are my enticements, and they are",
  "sufficient to conquer all fear of danger or death and to induce me to commence this laborious",
  "voyage with the joy a child feels when he embarks in a little boat, with his holiday mates,",
  "on an expedition of discovery up his native river. But supposing all these conjectures to be",
  "false, you cannot contest the inestimable benefit which I shall confer on all mankind, to the",
  "last generation, by discovering a passage near the pole to those countries, to reach which at",
  "present so many months are requisite; or by ascertaining the secret of the magnet, which, if",
  "at all possible, can only be effected by an undertaking such as mine.",
  "These reflections have dispelled the agitation with which I began my letter, and I feel my",
  "heart glow with an enthusiasm which elevates me to heaven, for nothing contributes so much",
  "to tranquillise the mind as a steady purpose — a point on which the soul may fix its",
  "intellectual eye. This expedition has been the favourite dream of my early years. I have read",
  "with ardour the accounts of the various voyages which have been made in the prospect of",
  "arriving at the North Pacific Ocean through the seas which surround the pole. You may remember",
  "that a history of all the voyages made for purposes of discovery composed the whole of our",
  "good Uncle Thomas' library. My education was neglected, yet I was passionately fond of reading.",
  "These volumes were my study day and night, and my familiarity with them increased that regret",
  "which I had felt, as a child, on learning that my father's dying injunction had forbidden my",
  "uncle to allow me to embark in a seafaring life.",
  "These visions faded when I perused, for the first time, those poets whose effusions entranced",
  "my soul and lifted it to heaven. I also became a poet and for one year lived in a paradise of",
  "my own creation; I imagined that I also might obtain a niche in the temple where the names of",
  "Homer and Shakespeare are consecrated. You are well acquainted with my failure and how heavily",
  "I bore the disappointment. But just at that time I inherited the fortune of my cousin, and",
  "my thoughts were turned into the channel of their earlier bent.",
  "Six years have passed since I resolved on my present undertaking. I can, even now, remember",
  "the hour from which I dedicated myself to this great enterprise. I commenced by inuring my body",
  "to hardship. I accompanied the whale-fishers on several expeditions to the North Sea; I",
  "voluntarily endured cold, famine, thirst, and want of sleep; I often worked harder than the",
  "common sailors during the day and devoted my nights to the study of mathematics, the theory",
  "of medicine, and those branches of physical science from which a naval adventurer might derive",
  "the greatest practical advantage. Twice I actually hired myself as an under-mate in a Greenland",
  "whaler, and acquitted myself to admiration. I must own I felt a little proud when my captain",
  "offered me the second dignity in the vessel and entreated me to remain with the greatest",
  "earnestness, so valuable did he consider my services.",
  "And now, dear Margaret, do I not deserve to accomplish some great purpose? My life might have",
  "been passed in ease and luxury, but I preferred glory to every enticement that wealth placed",
  "in my path. Oh, that some encouraging voice would answer in the affirmative! My courage and",
  "my resolution is firm; but my hopes fluctuate, and my spirits are often depressed. I am about",
  "to proceed on a long and difficult voyage, the emergencies of which will demand all my",
  "fortitude: I am required not only to raise the spirits of others, but sometimes to sustain",
  "my own, when theirs are failing.",
  "This is the most favourable period for travelling in Russia. They fly quickly over the snow",
  "in their sledges; the motion is pleasant, and, in my opinion, far more agreeable than that",
  "of an English stagecoach. The cold is not excessive, if you are wrapped in furs — a dress",
  "which I have already adopted, for there is a great difference between walking the deck and",
  "remaining seated motionless for hours, when no exercise prevents the blood from actually",
  "freezing in your veins. I have no ambition to lose my life on the post-road between St.",
  "Petersburgh and Archangel.",
  "I shall depart for the latter town in a fortnight or three weeks; and my intention is to hire",
  "a ship there, which can easily be done by paying the insurance for the owner, and to engage",
  "as many sailors as I think necessary among those who are accustomed to the whale-fishing. I",
  "do not intend to sail until the month of June; and when shall I return? Ah, dear sister, how",
  "can I answer this question? If I succeed, many, many months, perhaps years, will pass before",
  "you and I may meet. If I fail, you will see me again soon, or never.",
  "Farewell, my dear, excellent Margaret. Heaven shower down blessings on you, and save me, that",
  "I may again and again testify my gratitude for all your love and kindness.",
  "Your affectionate brother, R. Walton",
].join("\n");

console.log(`corpus: ${corpus.length} chars`);
console.log(`model: ${MODEL}`);
const QUESTION = "Why does Walton sail to the North Pole and what does he hope to discover?";
console.log(`question: ${QUESTION}`);

engineIngestText(corpus, "source:frankenstein.txt", "frankenstein", { pool: POOL });

const t0 = Date.now();
const ground = engineGroundQuery(
  QUESTION,
  { budget: 8000, maxUnits: 16, limit: 24, minScore: 0.1, pool: POOL }
);
console.log(`retrieved ${ground.total} passages, ${ground.folded} folded (${Date.now() - t0}ms)`);
if (!ground.citations.length) {
  console.error("no evidence — cannot run");
  process.exit(1);
}

ground.citations.forEach((c, i) => console.log(
  `  [${i+1}] terrain=${c.terrain} stance=${c.stance} score=${(c.score||0).toFixed(2)} "${(c.text||"").slice(0, 50)}..."`));

const { narratorSpans, cast } = discoverNarratorContext(ground.citations);
const morphology = loadMorphologyPrior();

console.log(`generating with ${MODEL}...`);
const t1 = Date.now();
const result = await runDeliberateAnswer({
  question: "What drives Walton to undertake his polar expedition?",
  citations: ground.citations,
  generate: say,
  narratorSpans,
  cast,
  morphology,
  maxSections: 5,
  maxRevisionRounds: 2,
  onProgress: (e) => {
    if (e.phase === "outline") console.log(`outline: ${e.sections} sections (withheld ${e.withheld})`);
    else if (e.phase === "section_titled") console.log(`  titled: "${e.title}"`);
    else if (e.phase === "section_drafted") console.log(`  drafted (${e.words} words)`);
    else if (e.phase === "section_revising") console.log(`  revising round ${e.round}: residual ${e.residual?.toFixed(3)}`);
    else if (e.phase === "section_closed") console.log(`  closed: "${e.title}"`);
    else if (e.phase === "assembled") console.log(`assembled: ${e.kept} kept, ${e.dropped} dropped`);
  },
});

const elapsed = ((Date.now() - t1) / 1000).toFixed(0);

const out = [
  `# What drives Walton to undertake his polar expedition?\n`,
  result.text,
  `\n## Sources\n`,
  ...result.citations.map((c, i) => {
    const src = String(c.source_id ?? "").replace(/^source:/, "").replace(/:chunk-\d+$/, "").replace(/^.*\//, "");
    return `[${c.index}] ${src} (score: ${(c.score||0).toFixed(2)}, terrain: ${c.terrain||"?"}, stance: ${c.stance||"?"})\n> ${String(c.text).slice(0, 200).replace(/\s+/g, " ")}…\n`;
  }),
  `\n## What this leaves out\n`,
  ...(ground.gaps || []).map((g) => `- engine: ${g.reason || g.type}`),
  ...(result.gaps || []).map((g) => `- pipeline: ${g.reason || g.type}`),
  `\n${result.sectionsKept} sections kept · ${result.sectionsDropped} dropped · ${elapsed}s`,
];

fs.writeFileSync(OUT, out.join("\n"));
console.log(`\nwrote ${OUT} · ${result.sectionsKept} kept, ${result.sectionsDropped} dropped · ${elapsed}s`);
