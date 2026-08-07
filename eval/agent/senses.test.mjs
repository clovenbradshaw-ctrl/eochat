// Deterministic coverage for senses.mjs's dispatcher: routes to the right
// LOCAL sense (WAV, PNG), and — the part that matters for "tag in other ML
// systems" — reports a SPECIFIC, named gap for anything neither covers,
// rather than a bare "unsupported" or (worse) silently returning nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { perceive, looksLikePng, parsePng } from "./senses.mjs";
import { writeWav } from "./media.mjs";

// Minimal, real, spec-shaped PNG header: signature + IHDR chunk only (no
// IDAT/IEND — parsePng only ever reads the fixed IHDR offset, and this
// mirrors media.mjs's own "hand-built, spec-accurate, not a full real file"
// fixture style). CRC is zeroed — parsePng does not validate it, honestly
// documented in senses.mjs as a stated scope limit, not an oversight.
function buildPngHeader({ width, height, bitDepth = 8, colorType = 6, interlaced = 0 }) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(bitDepth, 8);
  ihdrData.writeUInt8(colorType, 9);
  ihdrData.writeUInt8(0, 10); // compression method
  ihdrData.writeUInt8(0, 11); // filter method
  ihdrData.writeUInt8(interlaced, 12);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(13, 0);
  const crcBuf = Buffer.alloc(4); // unvalidated, zeroed
  return Buffer.concat([sig, lenBuf, Buffer.from("IHDR", "ascii"), ihdrData, crcBuf]);
}

test("perceive: text content is identified as text, not routed to any binary sense", () => {
  const result = perceive(Buffer.from("const x = 1;\n", "utf8"), "a.js");
  assert.equal(result.kind, "text");
  assert.match(result.note, /read_file/);
});

test("perceive: routes a WAV file to the wav sense, envelope and all", () => {
  const wav = writeWav({ samples: new Int16Array(1600) });
  const result = perceive(wav, "clip.wav");
  assert.equal(result.sense, "wav");
  assert.equal(result.kind, "wav");
  assert.equal(result.energyEnvelope.length, 16);
});

test("looksLikePng / parsePng: real signature and IHDR fields round-trip", () => {
  const png = buildPngHeader({ width: 640, height: 480, bitDepth: 8, colorType: 6 });
  assert.equal(looksLikePng(png), true);
  const parsed = parsePng(png);
  assert.equal(parsed.width, 640);
  assert.equal(parsed.height, 480);
  assert.equal(parsed.colorType, "truecolor+alpha (RGBA)");
  assert.equal(parsed.interlaced, false);
});

test("perceive: routes a PNG file to the png sense and names the pixel-data gap honestly", () => {
  const png = buildPngHeader({ width: 100, height: 50, colorType: 2 });
  const result = perceive(png, "photo.png");
  assert.equal(result.sense, "png");
  assert.equal(result.width, 100);
  assert.equal(result.height, 50);
  assert.match(result.pixelDataGap, /not decoded/);
});

test("perceive: an unrecognized binary format gets a SPECIFIC gap naming real cataloged ML systems, not a bare failure", () => {
  // A NUL byte up front makes this binary; it matches no registered signature.
  const mystery = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
  const result = perceive(mystery, "unknown.bin");
  assert.equal(result.kind, "unknown-binary");
  assert.match(result.error, /no local sense recognizes/);
  assert.ok(result.catalogedSensesThatMightApply.length > 0, "must name real cataloged systems, not just say 'unsupported'");
  assert.ok(result.catalogedSensesThatMightApply.every((s) => s.id && s.name && "needsEndpoint" in s));
  assert.match(result.catalogGapNote, /endpoint/);
});
