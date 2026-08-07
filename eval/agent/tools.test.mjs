// Deterministic coverage for agent/tools.mjs's edit_file organ — the
// surgical old_string/new_string tool grown so the agent can work on real,
// larger files without needing to retype the whole file per write_file's
// token budget. Its safety property (unique match or an honest refusal) is
// the whole point, so it gets pinned down directly, not just exercised
// incidentally through a task run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTools } from "./tools.mjs";
import { writeWav } from "./media.mjs";

function freshSandbox() {
  return mkdtempSync(join(tmpdir(), "tools-test-"));
}

test("edit_file replaces a unique match and writes only the delta", () => {
  const dir = freshSandbox();
  try {
    writeFileSync(join(dir, "a.js"), "const x = 1;\nconst y = 2;\n");
    const { tools } = createTools(dir);
    const result = tools.edit_file.run({ path: "a.js", old_string: "const x = 1;", new_string: "const x = 100;" });
    assert.equal(result.ok, true);
    assert.equal(readFileSync(join(dir, "a.js"), "utf8"), "const x = 100;\nconst y = 2;\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit_file refuses an old_string that is not found, with a specific reason", () => {
  const dir = freshSandbox();
  try {
    writeFileSync(join(dir, "a.js"), "const x = 1;\n");
    const { tools } = createTools(dir);
    const result = tools.edit_file.run({ path: "a.js", old_string: "const z = 9;", new_string: "const z = 10;" });
    assert.match(result.error, /not found/);
    assert.equal(readFileSync(join(dir, "a.js"), "utf8"), "const x = 1;\n", "the file must be untouched on refusal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit_file refuses an old_string that matches more than once, rather than guessing which", () => {
  const dir = freshSandbox();
  try {
    writeFileSync(join(dir, "a.js"), "foo();\nfoo();\n");
    const { tools } = createTools(dir);
    const result = tools.edit_file.run({ path: "a.js", old_string: "foo();", new_string: "bar();" });
    assert.match(result.error, /2 places/);
    assert.equal(readFileSync(join(dir, "a.js"), "utf8"), "foo();\nfoo();\n", "the file must be untouched on refusal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit_file's not-found error diagnoses a real observed model mistake: wrapping old_string in extra literal quote marks", () => {
  const dir = freshSandbox();
  try {
    writeFileSync(join(dir, "a.js"), "obj[header] = row[index];\n");
    const { tools } = createTools(dir);
    const result = tools.edit_file.run({ path: "a.js", old_string: '"obj[header] = row[index];"', new_string: "x" });
    assert.match(result.error, /not found/);
    assert.match(result.error, /extra quote marks/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit_file cannot escape the sandbox", () => {
  const dir = freshSandbox();
  try {
    const { tools } = createTools(dir);
    const result = tools.edit_file.run({ path: "../../etc/passwd", old_string: "root", new_string: "x" });
    assert.match(result.error, /escapes the sandbox/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read_file refuses a binary (WAV) file honestly instead of returning corrupted text", () => {
  const dir = freshSandbox();
  try {
    writeFileSync(join(dir, "clip.wav"), writeWav({ samples: new Int16Array(100) }));
    const { tools } = createTools(dir);
    const result = tools.read_file.run({ path: "clip.wav" });
    assert.equal(result.content, undefined, "must never hand back garbled binary content as if it were text");
    assert.match(result.error, /binary content/);
    assert.match(result.error, /perceive/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read_file still reads ordinary text files exactly as before", () => {
  const dir = freshSandbox();
  try {
    writeFileSync(join(dir, "a.js"), "const x = 1;\n");
    const { tools } = createTools(dir);
    const result = tools.read_file.run({ path: "a.js" });
    assert.equal(result.content, "const x = 1;\n");
    assert.equal(result.truncated, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("perceive routes a WAV file to the wav sense: real chunk layout and duration, walking past an extra chunk", () => {
  const dir = freshSandbox();
  try {
    const samples = new Int16Array(1600); // 0.2s @ 8000Hz mono
    writeFileSync(join(dir, "clip.wav"), writeWav({
      sampleRate: 8000, channels: 1, bitsPerSample: 16, samples,
      extraChunks: [{ id: "LIST", data: Buffer.from("INFOISFT", "ascii") }],
    }));
    const { tools } = createTools(dir);
    const result = tools.perceive.run({ path: "clip.wav" });
    assert.equal(result.sense, "wav");
    assert.deepEqual(result.chunks.map((c) => c.id), ["fmt ", "LIST", "data"]);
    assert.equal(result.fmt.sampleRate, 8000);
    assert.equal(result.durationSeconds, 0.2);
    assert.equal(result.energyEnvelope.length, 16, "default envelope size");
    assert.equal(result.energyEnvelopeSamplesFolded, 1600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("perceive's WAV envelope size stays fixed at a caller-chosen bucket count regardless of clip length — the actual prompt-cost guarantee", () => {
  const dir = freshSandbox();
  try {
    const shortWav = writeWav({ samples: new Int16Array(800) }); // 0.1s
    const longWav = writeWav({ samples: new Int16Array(800_000) }); // 100s
    writeFileSync(join(dir, "short.wav"), shortWav);
    writeFileSync(join(dir, "long.wav"), longWav);
    const { tools } = createTools(dir);

    const short = tools.perceive.run({ path: "short.wav", buckets: 8 });
    const long = tools.perceive.run({ path: "long.wav", buckets: 8 });

    assert.equal(short.energyEnvelope.length, 8);
    assert.equal(long.energyEnvelope.length, 8);
    assert.equal(JSON.stringify(short.energyEnvelope).length, JSON.stringify(long.energyEnvelope).length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("perceive routes a PNG file to the png sense: real width/height/color-type, pixel content named as a gap", () => {
  const dir = freshSandbox();
  try {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(320, 0); // width
    ihdrData.writeUInt32BE(240, 4); // height
    ihdrData.writeUInt8(8, 8); // bit depth
    ihdrData.writeUInt8(2, 9); // color type: truecolor
    const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(13, 0);
    const png = Buffer.concat([sig, lenBuf, Buffer.from("IHDR", "ascii"), ihdrData, Buffer.alloc(4)]);
    writeFileSync(join(dir, "photo.png"), png);

    const { tools } = createTools(dir);
    const result = tools.perceive.run({ path: "photo.png" });
    assert.equal(result.sense, "png");
    assert.equal(result.width, 320);
    assert.equal(result.height, 240);
    assert.match(result.pixelDataGap, /not decoded/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("perceive on a plain text file reports kind:text and points at read_file, not a binary-sense error", () => {
  const dir = freshSandbox();
  try {
    writeFileSync(join(dir, "notes.txt"), "just some text\n");
    const { tools } = createTools(dir);
    const result = tools.perceive.run({ path: "notes.txt" });
    assert.equal(result.kind, "text");
    assert.match(result.note, /read_file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("perceive on an unrecognized binary format names real cataloged ML systems instead of a bare failure", () => {
  const dir = freshSandbox();
  try {
    writeFileSync(join(dir, "mystery.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]));
    const { tools } = createTools(dir);
    const result = tools.perceive.run({ path: "mystery.bin" });
    assert.equal(result.kind, "unknown-binary");
    assert.match(result.error, /no local sense recognizes/);
    assert.ok(result.catalogedSensesThatMightApply.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
