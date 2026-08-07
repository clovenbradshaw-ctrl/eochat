// Deterministic coverage for media.mjs: the honest binary sniff and the
// from-scratch WAV chunk walker/writer. writeWav/parseWav are tested as a
// round trip (write a real WAV, parse it back, check the numbers), including
// the exact real-world wrinkle this module exists for — an extra chunk
// sitting between 'fmt ' and 'data' — so a regression that silently goes
// back to "assume a fixed offset" is caught here, not just in the eval task.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sniffBinary, looksLikeWav, parseWav, writeWav } from "./media.mjs";

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
