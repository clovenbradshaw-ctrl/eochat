// Provided verification script — the agent is told to make this pass by
// actually running it, not to guess. Do not modify this file.
//
// The fixture below is a REAL, valid WAV file, built from scratch (no
// ffmpeg, no checked-in binary asset) with one deliberate wrinkle: a 'LIST'
// metadata chunk sits between the 'fmt ' chunk and the 'data' chunk — real
// encoders add chunks like this routinely. A duration.js that assumes audio
// data starts at a fixed byte offset (e.g. the commonly-cited "44 bytes in")
// will read the wrong bytes as 'data' and get the wrong duration.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
function u16le(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff, 0); return b; }
function chunk(id, data) {
  const pad = data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from(id, "ascii"), u32le(data.length), data, pad]);
}

const sampleRate = 8000, channels = 1, bitsPerSample = 16;
const byteRate = (sampleRate * channels * bitsPerSample) / 8; // 16000
const blockAlign = (channels * bitsPerSample) / 8;
const fmtData = Buffer.concat([u16le(1), u16le(channels), u32le(sampleRate), u32le(byteRate), u16le(blockAlign), u16le(bitsPerSample)]);
const fmtChunk = chunk("fmt ", fmtData);
const listChunk = chunk("LIST", Buffer.from("INFOISFTeval-fixture", "ascii")); // odd length on purpose: exercises the pad byte
const dataBuf = Buffer.alloc(1600, 0); // 1600 bytes / 16000 byteRate = 0.1s of silence
const dataChunk = chunk("data", dataBuf);
const body = Buffer.concat([Buffer.from("WAVE", "ascii"), fmtChunk, listChunk, dataChunk]);
const wav = Buffer.concat([Buffer.from("RIFF", "ascii"), u32le(body.length), body]);

const wavPath = "._check_fixture.wav";
writeFileSync(wavPath, wav);

let out;
try {
  out = execFileSync("node", ["duration.js", wavPath], { encoding: "utf8", timeout: 10_000 });
} catch (err) {
  console.error("CHECK: FAIL — duration.js crashed: " + err.message);
  process.exit(1);
}

const got = Number(out.trim());
const expected = 0.1; // 1600 data bytes / 16000 byteRate
if (!Number.isFinite(got) || Math.abs(got - expected) > 1e-9) {
  console.error(`CHECK: FAIL — expected duration.js to print ${expected} (this fixture has a 'LIST' chunk between 'fmt ' and 'data', so the data byte count is NOT at a fixed offset), got: ${JSON.stringify(out)}`);
  process.exit(1);
}

console.log("CHECK: PASS");
