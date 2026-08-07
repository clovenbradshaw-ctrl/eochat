// Deterministic coverage for media.mjs: the honest binary sniff and the
// from-scratch WAV chunk walker/writer. writeWav/parseWav are tested as a
// round trip (write a real WAV, parse it back, check the numbers), including
// the exact real-world wrinkle this module exists for — an extra chunk
// sitting between 'fmt ' and 'data' — so a regression that silently goes
// back to "assume a fixed offset" is caught here, not just in the eval task.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sniffBinary, looksLikeWav, parseWav, writeWav, computeEnergyEnvelope } from "./media.mjs";

test("sniffBinary: plain source text has no NUL byte", () => {
  assert.equal(sniffBinary(Buffer.from("const x = 1;\nconsole.log(x);\n", "utf8")), false);
});

test("sniffBinary: a real WAV buffer trips the NUL heuristic", () => {
  const wav = writeWav({ samples: new Int16Array(10) });
  assert.equal(sniffBinary(wav), true);
});

test("looksLikeWav / parseWav: rejects non-WAV content honestly, not silently", () => {
  const notWav = Buffer.from("just some text, not a RIFF file at all", "utf8");
  assert.equal(looksLikeWav(notWav), false);
  assert.match(parseWav(notWav).error, /not a RIFF\/WAVE file/);
});

test("parseWav round-trips a plain WAV with no extra chunks (the simple/canonical case)", () => {
  const samples = new Int16Array(800); // 0.1s @ 8000Hz mono
  const wav = writeWav({ sampleRate: 8000, channels: 1, bitsPerSample: 16, samples });
  const parsed = parseWav(wav);
  assert.equal(parsed.fmt.sampleRate, 8000);
  assert.equal(parsed.fmt.channels, 1);
  assert.equal(parsed.fmt.bitsPerSample, 16);
  assert.equal(parsed.dataBytes, 1600);
  assert.equal(parsed.durationSeconds, 0.1);
  assert.deepEqual(parsed.chunks.map((c) => c.id), ["fmt ", "data"]);
});

test("parseWav walks past an extra chunk between fmt and data instead of assuming a fixed offset", () => {
  const samples = new Int16Array(1600); // 0.2s @ 8000Hz mono
  const wav = writeWav({
    sampleRate: 8000, channels: 1, bitsPerSample: 16, samples,
    extraChunks: [{ id: "LIST", data: Buffer.from("INFOISFTeval\0", "ascii") }], // odd-length data on purpose: exercises the pad byte
  });
  const parsed = parseWav(wav);
  assert.deepEqual(parsed.chunks.map((c) => c.id), ["fmt ", "LIST", "data"]);
  assert.equal(parsed.dataBytes, 3200);
  assert.equal(parsed.durationSeconds, 0.2);
});

test("parseWav: a zero-length data chunk is a real, honest 0-second duration, not an error", () => {
  const wav = writeWav({ samples: new Int16Array(0) });
  const parsed = parseWav(wav);
  assert.equal(parsed.dataBytes, 0);
  assert.equal(parsed.durationSeconds, 0);
});

test("parseWav reports a typed gap when there is no data chunk at all, rather than guessing a duration", () => {
  // Hand-built: RIFF header + a fmt chunk only, no data chunk.
  const fmtData = Buffer.concat([
    Buffer.from([1, 0, 1, 0]), // audioFormat=1 (PCM), channels=1
    Buffer.from([0x40, 0x1f, 0, 0]), // sampleRate=8000 LE
    Buffer.from([0x80, 0x3e, 0, 0]), // byteRate=16000 LE
    Buffer.from([2, 0, 16, 0]), // blockAlign=2, bitsPerSample=16
  ]);
  const fmtChunk = Buffer.concat([Buffer.from("fmt ", "ascii"), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(fmtData.length, 0); return b; })(), fmtData]);
  const body = Buffer.concat([Buffer.from("WAVE", "ascii"), fmtChunk]);
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32LE(body.length, 0);
  const wav = Buffer.concat([Buffer.from("RIFF", "ascii"), sizeBuf, body]);

  const parsed = parseWav(wav);
  assert.match(parsed.error, /no 'data' chunk/);
  assert.ok(parsed.fmt);
});

// --- computeEnergyEnvelope: the actual claim under test is that its OUTPUT
// SIZE — and therefore the prompt-token cost of handing it to a model — does
// not grow with the input file's length. A tool result becomes part of the
// next turn's prompt (react-loop.mjs's formatObservation), so an envelope
// whose size scaled with the file would silently reintroduce, for audio, the
// exact "context grows with content size" failure this eval's text tools
// (MAX_READ_CHARS, surf/fold's token budget) already refuse to allow.

function silenceThenTone(sampleCount, split) {
  const samples = new Int16Array(sampleCount);
  for (let i = split; i < sampleCount; i++) samples[i] = 20000; // loud, second half only
  return samples;
}

test("computeEnergyEnvelope: output length is fixed by `buckets`, not by file length (the whole point)", () => {
  const shortClip = writeWav({ samples: silenceThenTone(1_600, 800) }); // 0.1s
  const longClip = writeWav({ samples: silenceThenTone(1_600_000, 800_000) }); // 100s — 1000x longer

  const shortEnv = computeEnergyEnvelope(shortClip, parseWav(shortClip), { buckets: 16 });
  const longEnv = computeEnergyEnvelope(longClip, parseWav(longClip), { buckets: 16 });

  assert.equal(shortEnv.envelope.length, 16);
  assert.equal(longEnv.envelope.length, 16);
  assert.equal(JSON.stringify(shortEnv.envelope).length, JSON.stringify(longEnv.envelope).length, "the serialized prompt cost must be identical regardless of the 1000x file-length difference");
  // The real work still happened — a 1000x longer clip folded 1000x more real samples per bucket, honestly reported, not silently averaged away.
  assert.equal(longEnv.framesPerBucket, shortEnv.framesPerBucket * 1000);
});

test("computeEnergyEnvelope: the fixed-size envelope still preserves the real signal shape (silence half, loud half)", () => {
  const wav = writeWav({ samples: silenceThenTone(1600, 800) });
  const { envelope } = computeEnergyEnvelope(wav, parseWav(wav), { buckets: 16 });
  const firstHalf = envelope.slice(0, 8);
  const secondHalf = envelope.slice(8);
  assert.ok(firstHalf.every((v) => v === 0), `expected silence in the first half, got ${firstHalf}`);
  assert.ok(secondHalf.every((v) => v === 20000), `expected the loud tone in the second half, got ${secondHalf}`);
});

test("computeEnergyEnvelope: a clip shorter than the bucket count folds to fewer buckets, honestly, not padded", () => {
  const wav = writeWav({ samples: new Int16Array(5) });
  const env = computeEnergyEnvelope(wav, parseWav(wav), { buckets: 16 });
  assert.equal(env.buckets, 5);
  assert.equal(env.envelope.length, 5);
});

test("computeEnergyEnvelope: an odd sample count folds its remainder into the last bucket, and says so", () => {
  const wav = writeWav({ samples: new Int16Array(19) }); // 19 / 4 buckets = 4 remainder 3
  const env = computeEnergyEnvelope(wav, parseWav(wav), { buckets: 4 });
  assert.equal(env.framesPerBucket, 4);
  assert.equal(env.remainderFoldedIntoLastBucket, 3);
});

test("computeEnergyEnvelope: refuses non-16-bit PCM honestly instead of misreading it", () => {
  const wav = writeWav({ samples: new Int16Array(10) });
  const parsed = parseWav(wav);
  parsed.fmt.bitsPerSample = 8; // simulate an 8-bit file without hand-building one
  const env = computeEnergyEnvelope(wav, parsed);
  assert.match(env.error, /16-bit/);
});
