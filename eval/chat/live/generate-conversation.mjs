// Scalable synthetic long-conversation generator for the live adversary
// comparison (run-live.mjs). Plants a fixed number of distinct, code-bearing
// facts at the very start of the conversation, then pads with filler small
// talk out to whatever total turn count the caller wants — the same shape
// eval/chat/scenarios/*.mjs hand-authored at a fixed length, but parametric
// so the comparison can be run "at scale" instead of at one fixed size.

const FILLER_QA = [
  { q: "What's the weather like on Mars?", a: "Mars has a thin CO2 atmosphere and averages around -60C." },
  { q: "Who wrote Moby-Dick?", a: "Herman Melville wrote Moby-Dick, published in 1851." },
  { q: "What's 17 times 23?", a: "17 times 23 is 391." },
  { q: "Name a moon of Jupiter.", a: "Europa is one of Jupiter's moons." },
  { q: "What's the capital of Peru?", a: "The capital of Peru is Lima." },
  { q: "How many strings does a violin have?", a: "A violin has four strings." },
  { q: "What's a good book about the ocean?", a: "The Sea Around Us by Rachel Carson is a classic." },
  { q: "What's the boiling point of nitrogen?", a: "Nitrogen boils at about -196C at standard pressure." },
  { q: "What's the tallest mountain in Africa?", a: "Mount Kilimanjaro, at about 5,895 meters." },
  { q: "Name a famous bridge in San Francisco.", a: "The Golden Gate Bridge." },
  { q: "What year did the Berlin Wall fall?", a: "1989." },
  { q: "What's a common gas used in weather balloons?", a: "Helium is commonly used." },
  { q: "Who painted Starry Night?", a: "Vincent van Gogh." },
  { q: "What's the freezing point of seawater?", a: "About -2C, lower than fresh water because of dissolved salt." },
  { q: "Name a river that flows through Cairo.", a: "The Nile." },
  { q: "What's the largest desert in the world?", a: "The Antarctic Desert is technically the largest by area." },
  { q: "What language is spoken in Brazil?", a: "Portuguese." },
  { q: "How many bones are in the adult human body?", a: "206." },
  { q: "What's the chemical symbol for gold?", a: "Au." },
  { q: "Name a planet with rings.", a: "Saturn has the most prominent ring system." },
  { q: "What's the speed of sound at sea level?", a: "About 343 meters per second in air at 20C." },
  { q: "Who composed the Ninth Symphony?", a: "Ludwig van Beethoven." },
  { q: "What's the longest river in the world?", a: "The Nile, by most measurements, at around 6,650 km." },
  { q: "What's a group of crows called?", a: "A murder." },
  { q: "What's the smallest prime number?", a: "2." },
  { q: "Name a country that borders both France and Spain.", a: "Andorra sits directly between them." },
  { q: "What's the currency of Japan?", a: "The yen." },
  { q: "Who discovered penicillin?", a: "Alexander Fleming, in 1928." },
  { q: "What's the tallest building in the world?", a: "The Burj Khalifa in Dubai." },
  { q: "How many continents are there?", a: "Seven, conventionally." },
  { q: "What's the main ingredient in guacamole?", a: "Avocado." },
  { q: "Name an element that is liquid at room temperature.", a: "Mercury." },
  { q: "What's the capital of Australia?", a: "Canberra, not Sydney." },
  { q: "What's the fastest land animal?", a: "The cheetah." },
  { q: "Who wrote Pride and Prejudice?", a: "Jane Austen." },
  { q: "What's the largest ocean?", a: "The Pacific Ocean." },
  { q: "What's the hardest natural substance?", a: "Diamond." },
  { q: "Name a country in Scandinavia.", a: "Norway, Sweden, or Denmark." },
  { q: "What's the boiling point of water at sea level?", a: "100C, or 212F." },
  { q: "How many chambers does a human heart have?", a: "Four." },
];

// Deliberately mundane, non-credential-flavored topics. Earlier drafts used
// spy/security-adjacent wording ("vault access code", "abort code") and it
// confounded the comparison: real Claude models sometimes refuse to
// repeat back anything that reads like a security credential, which is a
// safety-classifier behavior, not a memory failure — it made the growing-
// context adversary look worse than its context assembly actually is. These
// read as ordinary logistics details nobody's safety training flags.
const FACT_TOPICS = [
  "restaurant reservation number", "parking spot number", "library hold number",
  "shuttle bus number", "conference room booking code", "warranty claim number",
  "return authorization number", "delivery tracking code", "event badge number",
  "photo album reference number", "invoice number", "locker number",
  "coat check ticket number", "raffle ticket number", "membership renewal code",
  "gate number", "seat assignment code", "recipe box number", "playlist code",
  "loyalty program number",
];

const CODE_WORDS = ["Falcon", "Echo", "Vertex", "Cobalt", "Ember", "Halo", "Nova", "Onyx", "Quartz", "Raven",
  "Meridian", "Zephyr", "Talon", "Griffin", "Orion", "Pallas", "Sable", "Wraith", "Kestrel", "Basalt"];

function makeCode(seed, i) {
  const word = CODE_WORDS[(seed + i * 7) % CODE_WORDS.length];
  const num = ((seed * 13 + i * 31) % 89) + 10;
  return `X${i}-${word}-${num}`;
}

/**
 * Build a scripted conversation of exactly `totalTurns` (question, answer)
 * exchanges: the first `factCount` turns each plant one distinct fact
 * (verbatim, code-bearing, matching the shape eval/chat/scenarios/*.mjs
 * already use), then filler small talk pads out to `totalTurns`.
 *
 * @returns {{ script: {question:string, answer:string}[], facts: {topic:string, code:string, probe:string}[] }}
 */
export function buildScaledConversation({ totalTurns, factCount, seed = 0 }) {
  if (factCount > totalTurns) throw new RangeError("factCount must not exceed totalTurns");
  const facts = [];
  const script = [];

  for (let i = 0; i < factCount; i++) {
    const topic = FACT_TOPICS[(seed + i) % FACT_TOPICS.length];
    const code = makeCode(seed, i);
    facts.push({ topic, code, probe: `What was the ${topic} I gave you earlier?` });
    script.push({
      question: `Quick note for the record: the ${topic} is designation ${code}.`,
      answer: `Logged — the ${topic} is designation ${code}.`,
    });
  }

  let fillerIdx = seed % FILLER_QA.length;
  while (script.length < totalTurns) {
    const f = FILLER_QA[fillerIdx % FILLER_QA.length];
    script.push({ question: f.q, answer: f.a });
    fillerIdx++;
  }

  return { script, facts };
}
