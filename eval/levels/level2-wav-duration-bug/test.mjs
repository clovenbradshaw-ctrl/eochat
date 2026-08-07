// Independently-authored held-out oracle — a different WAV-building path
// than the seeded check.mjs (its own inline chunk writer, not an import),
// exercising fixtures check.mjs never showed the agent: a plain WAV with NO
// extra chunk (the simple/canonical case must still work), a WAV with TWO
// extra chunks stacked before data, and a different sample rate/channel
// count. Verified by hand: every expected duration below is dataBytes /
// byteRate, computed independently of duration.js.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
function u16le(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff, 0); return b; }
function chunk(id, data) {
  const pad = data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from(id, "ascii"), u32le(data.length), data, pad]);
}
function buildWav({ sampleRate, channels, bitsPerSample, dataBytes, extraChunks = [] }) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const fmtData = Buffer.concat([u16le(1), u16le(channels), u32le(sampleRate), u32le(byteRate), u16le(blockAlign), u16le(bitsPerSample)]);
  const parts = [chunk("fmt ", fmtData), ...extraChunks.map((c) => chunk(c.id, c.data)), chunk("data", Buffer.alloc(dataBytes, 0))];
  const body = Buffer.concat([Buffer.from("WAVE", "ascii"), ...parts]);
  return { wav: Buffer.concat([Buffer.from("RIFF", "ascii"), u32le(body.length), body]), byteRate };
}

export async function evaluate(sandboxDir) {
  const checks = [];
  const check = (name, fn) => {
    try { checks.push({ name, pass: !!fn(), message: "" }); }
    catch (err) { checks.push({ name, pass: false, message: err.message }); }
  };

  const run = (wavOpts) => {
    const { wav, byteRate } = buildWav(wavOpts);
    const p = join(sandboxDir, `._held_out_${Math.random().toString(36).slice(2)}.wav`);
    writeFileSync(p, wav);
    const out = execFileSync("node", ["duration.js", p], { cwd: sandboxDir, encoding: "utf8", timeout: 10_000 });
    return { got: Number(out.trim()), expected: wavOpts.dataBytes / byteRate };
  };

  check("held-out generalization: a plain WAV with NO extra chunk (the simple/canonical case)", () => {
    const { got, expected } = run({ sampleRate: 8000, channels: 1, bitsPerSample: 16, dataBytes: 800 });
    return Math.abs(got - expected) < 1e-9;
  });

  check("REGRESSION (the seeded quirk): one extra chunk between fmt and data", () => {
    const { got, expected } = run({
      sampleRate: 8000, channels: 1, bitsPerSample: 16, dataBytes: 1600,
      extraChunks: [{ id: "LIST", data: Buffer.from("INFOISFTeval-fixture", "ascii") }],
    });
    return Math.abs(got - expected) < 1e-9;
  });

  check("held-out generalization: TWO extra chunks stacked before data", () => {
    const { got, expected } = run({
      sampleRate: 8000, channels: 1, bitsPerSample: 16, dataBytes: 2400,
      extraChunks: [
        { id: "fact", data: Buffer.from([1, 2, 3, 4]) },
        { id: "LIST", data: Buffer.from("INFOIART", "ascii") },
      ],
    });
    return Math.abs(got - expected) < 1e-9;
  });

  check("held-out generalization: a different sample rate and stereo channel count", () => {
    const { got, expected } = run({ sampleRate: 44100, channels: 2, bitsPerSample: 16, dataBytes: 17640 });
    return Math.abs(got - expected) < 1e-6;
  });

  return { checks };
}
