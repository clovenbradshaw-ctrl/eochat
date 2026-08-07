// A real, ffmpeg-free "sense" for the coding agent: honest binary detection,
// and a from-scratch WAV (RIFF/WAVE) parser/writer.
//
// Why this exists: agent/tools.mjs's read_file used to run every file
// through `readFileSync(abs, "utf8")` unconditionally. For a real binary
// asset (a WAV file, an image) that does not corrupt loudly — Buffer#toString
// silently returns mojibake/replacement characters instead of throwing — so
// the agent would see garbage and (reasonably) treat it as garbage text
// content, never as "this is a different medium, not text." That is exactly
// the failure eo-constitution's II.1 names for text: "stable spans are a
// false permanency" — every file was being forced through a text-shaped
// tool whether or not it was text. This module is what lets read_file refuse
// honestly instead, and gives the agent a real, structured way to inspect a
// WAV file's own layout instead of being blind to it.
//
// Deliberately narrow, on purpose: WAV is the one audio container whose
// on-disk format is a small, fully public, byte-exact spec (a sequence of
// RIFF chunks) simple enough to decode correctly by hand, with zero
// dependencies and no external binary. eoreader6's own
// packages/engine/perceiver/audio/material.js already does real perceptual
// reduction (RMS/flux energy over decoded PCM) but shells out to system
// ffmpeg to decode — not installed in every environment this harness runs
// in (this one included). This module is a companion for exactly that gap,
// not a replacement or a claim that it supersedes ffmpeg-backed decoding.
// mp3/ogg/flac/compressed WAV are out of scope and parseWav says so,
// honestly, rather than guessing at bytes it cannot actually interpret.

const NUL_SCAN_BYTES = 8000;

/**
 * Git's own text-vs-binary heuristic: a NUL byte anywhere in the first
 * NUL_SCAN_BYTES means "not text" — no ordinary text encoding produces one,
 * and every binary format this module cares about (WAV, PNG, ...) puts one
 * within its first few dozen bytes. Cheap, no network, no library.
 */
export function sniffBinary(buf) {
  const scanLen = Math.min(buf.length, NUL_SCAN_BYTES);
  for (let i = 0; i < scanLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function looksLikeWav(buf) {
  return buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE";
}

/**
 * Walk a RIFF/WAVE container's chunks by their OWN declared sizes — never
 * assume audio data starts at a fixed offset (a common shortcut that breaks
 * the moment a real encoder inserts a 'LIST' or 'fact' chunk between 'fmt '
 * and 'data', which real-world WAV files do routinely). Returns every chunk
 * found, in order, honestly, plus the decoded fmt/data facts when present.
 * RIFF chunks are word-aligned: an odd-sized chunk is followed by one pad
 * byte that is not counted in its own declared size.
 */
export function parseWav(buf) {
  if (!looksLikeWav(buf)) {
    return { error: "not a RIFF/WAVE file (missing RIFF/WAVE magic bytes) — only WAV is supported" };
  }
  const chunks = [];
  let fmt = null;
  let dataBytes = null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    chunks.push({ id, size, offset: bodyStart });
    if (id === "fmt " && bodyStart + 16 <= buf.length) {
      fmt = {
        audioFormat: buf.readUInt16LE(bodyStart),
        channels: buf.readUInt16LE(bodyStart + 2),
        sampleRate: buf.readUInt32LE(bodyStart + 4),
        byteRate: buf.readUInt32LE(bodyStart + 8),
        blockAlign: buf.readUInt16LE(bodyStart + 12),
        bitsPerSample: buf.readUInt16LE(bodyStart + 14),
      };
    } else if (id === "data") {
      dataBytes = size;
    }
    offset = bodyStart + size + (size % 2); // skip the word-alignment pad byte, if any
  }
  if (!fmt) return { error: "no 'fmt ' chunk found — cannot determine sample rate/channels", chunks };
  if (dataBytes === null) return { error: "no 'data' chunk found — cannot determine duration", chunks, fmt };
  const durationSeconds = fmt.byteRate > 0 ? dataBytes / fmt.byteRate : null;
  return { chunks, fmt, dataBytes, durationSeconds };
}

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}
function u16le(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff, 0);
  return b;
}
function riffChunk(id, data) {
  const pad = data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from(id, "ascii"), u32le(data.length), data, pad]);
}

/**
 * Build a real, valid WAV buffer from scratch — no dependencies, used to
 * synthesize test fixtures (including ones with extra chunks between fmt
 * and data, the exact real-world wrinkle parseWav has to survive) without
 * needing ffmpeg or a checked-in binary asset.
 */
export function writeWav({ sampleRate = 8000, channels = 1, bitsPerSample = 16, samples = new Int16Array(0), extraChunks = [] } = {}) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const fmtData = Buffer.concat([u16le(1), u16le(channels), u32le(sampleRate), u32le(byteRate), u16le(blockAlign), u16le(bitsPerSample)]);
  const dataBuf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) dataBuf.writeInt16LE(samples[i], i * 2);

  const parts = [riffChunk("fmt ", fmtData), ...extraChunks.map((c) => riffChunk(c.id, c.data)), riffChunk("data", dataBuf)];
  const body = Buffer.concat([Buffer.from("WAVE", "ascii"), ...parts]);
  return Buffer.concat([Buffer.from("RIFF", "ascii"), u32le(body.length), body]);
}
