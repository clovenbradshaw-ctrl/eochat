// eval/agent/senses.mjs — the generalized sniff -> route -> fold dispatcher.
//
// Three real senses already proved the same shape independently in this
// codebase: text (ingest.mjs's surf/fold over a token budget), WAV audio
// (media.mjs's computeEnergyEnvelope, a fixed-bucket fold), and eoreader6's
// own perceiver `reduce()` functions (frame/scanline material folded from a
// growing-fraction read). This module makes that shape a real REGISTRY
// instead of one hand-built tool per format: sniff a file's real bytes,
// find the narrowest LOCAL sense that can actually read it, run it, fold
// its result to a declared budget — or, if no local sense exists, say so
// honestly AND name which of this app's already-cataloged ML systems
// (server/senses-catalog.js — the same catalog the UI's Senses tab draws
// from) would apply. That is what "tag in other ML systems applicable to
// this data type" means honestly here: point at the real ones that exist,
// admit none is wired to a live endpoint in this sandbox, rather than
// either silently doing nothing or claiming a capability that isn't real.
//
// Adding a new LOCAL sense means adding one { id, test, perceive } entry to
// LOCAL_SENSES below — the dispatcher, the binary/text sniff, and the
// gap-reporting for anything not yet covered are shared, not duplicated
// per format.

import { sniffBinary, looksLikeWav, parseWav, computeEnergyEnvelope } from "./media.mjs";
import { SENSES_CATALOG } from "../../server/senses-catalog.js";

// ---- PNG: a second, genuinely different, zero-dependency local sense ----
// PNG's IHDR chunk is REQUIRED by the spec to be the very first chunk, at a
// FIXED offset — unlike WAV's chunks, which is exactly why WAV needed a
// walker and PNG does not. Width/height/bit-depth/color-type are real,
// structural facts read straight off the bytes, no library involved.
// Pixel content itself (IDAT, zlib-compressed, per-scanline filtered) is
// NOT decoded here — a real, stated gap (see `pixelDataGap` below), not a
// silent claim that this covers pixels the way the audio envelope covers
// samples. CRC checks are skipped too, for the same "narrow but honest"
// reason: this reads structure, it does not validate the file.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_COLOR_TYPES = { 0: "grayscale", 2: "truecolor (RGB)", 3: "indexed (palette)", 4: "grayscale+alpha", 6: "truecolor+alpha (RGBA)" };

export function looksLikePng(buf) {
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE);
}

export function parsePng(buf) {
  if (!looksLikePng(buf)) return { error: "not a PNG file (missing PNG signature) — only PNG is supported for images" };
  if (buf.length < 33 || buf.toString("ascii", 12, 16) !== "IHDR") {
    return { error: "PNG signature present but no IHDR chunk found at the required fixed offset — file is truncated or malformed" };
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf.readUInt8(24);
  const colorTypeCode = buf.readUInt8(25);
  const interlaced = buf.readUInt8(28) === 1;
  return { width, height, bitDepth, colorType: PNG_COLOR_TYPES[colorTypeCode] ?? `unknown color type (${colorTypeCode})`, interlaced };
}

// ---- the registry ----
const LOCAL_SENSES = [
  {
    id: "wav",
    label: "WAV audio (RIFF/WAVE)",
    test: looksLikeWav,
    perceive(buf, { buckets } = {}) {
      const parsed = parseWav(buf);
      if (parsed.error) return parsed;
      const envelope = computeEnergyEnvelope(buf, parsed, buckets === undefined ? {} : { buckets });
      const result = { kind: "wav", chunks: parsed.chunks, fmt: parsed.fmt, dataBytes: parsed.dataBytes, durationSeconds: parsed.durationSeconds };
      if (envelope.error) result.energyEnvelopeError = envelope.error;
      else {
        result.energyEnvelope = envelope.envelope;
        result.energyEnvelopeFramesPerBucket = envelope.framesPerBucket;
        result.energyEnvelopeSamplesFolded = envelope.samplesFolded;
      }
      return result;
    },
  },
  {
    id: "png",
    label: "PNG image",
    test: looksLikePng,
    perceive(buf) {
      const parsed = parsePng(buf);
      if (parsed.error) return parsed;
      return {
        kind: "png",
        ...parsed,
        pixelDataGap: "structural header only — pixel content (IDAT) is not decoded by this local sense; see catalogedSensesThatMightApply for systems that could read actual pixel content",
      };
    },
  },
];

// Which cataloged (server/senses-catalog.js) systems are relevant to a
// binary this local registry cannot see the real content of. Filtered by
// category, not the whole catalog, so the gap report stays small (folded,
// not dumped) — the same discipline as everything else in this file.
function catalogSuggestions(category) {
  return SENSES_CATALOG.filter((s) => s.category === category).map((s) => ({ id: s.id, name: s.name, needsEndpoint: s.needsEndpoint }));
}

/**
 * The one generic entry point: sniff, route to the narrowest LOCAL sense
 * that matches, run it, and its result is already bounded by construction
 * (each sense's own perceive() folds — see media.mjs's computeEnergyEnvelope
 * for why that matters). If nothing local matches, report an honest,
 * SPECIFIC gap naming real cataloged systems instead of a bare "unsupported".
 */
export function perceive(buf, path, opts = {}) {
  if (!sniffBinary(buf)) {
    return { kind: "text", note: `"${path}" is text — use read_file, not perceive` };
  }
  for (const sense of LOCAL_SENSES) {
    if (sense.test(buf)) return { sense: sense.id, ...sense.perceive(buf, opts) };
  }
  const vlm = catalogSuggestions("vlm");
  return {
    kind: "unknown-binary",
    byteLength: buf.length,
    error: `no local sense recognizes this file's format (first bytes: ${buf.subarray(0, Math.min(4, buf.length)).toString("hex")}) — this app has no fixed-format decoder for it`,
    catalogedSensesThatMightApply: vlm,
    catalogGapNote: "these are cataloged in server/senses-catalog.js (the same list the UI's Senses tab draws from) but none has a configured endpoint in this environment — wiring one in, not writing a new local decoder, is what would actually let the agent see this file's real content",
  };
}

export { LOCAL_SENSES };
