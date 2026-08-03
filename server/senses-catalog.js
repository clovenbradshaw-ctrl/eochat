// senses-catalog.js — the library the Senses tab subscribes/activates from.
//
// A "sense" is a vision model that can be pointed at something ingested (a
// screenshot, a scanned page, an image) and asked what's there. Four kinds of
// question, four categories:
//   - grounding: WHERE something is on screen (GUI element coordinates)
//   - vlm:       WHAT a general image shows (captioning, visual QA)
//   - ocr:       the TEXT in an image or scanned page
//   - detection: WHAT + WHERE for real-world objects (open-vocabulary)
//
// This file only describes the library — names, licenses, what each model is
// good at. None of these run out of the box: every entry but Tesseract.js
// needs a self-hosted or cloud endpoint the reader supplies (see the Senses
// tab's "endpoint" field, senses-state.js). Tesseract.js is the one exception
// — it already runs in-browser with no endpoint, so it ships "connected".
// A sense with no endpoint is a real gap, not a silent no-op: the ingest
// paths that consult this catalog (ui/index.html's PDF-OCR fallback and
// image upload) say so out loud rather than pretending nothing was asked for.
//
// Static data, not derived from a running service — so this list is a
// snapshot of the field, not a live capability check. Benchmark numbers are
// vendor-reported; treat them as shortlist signal, not verified fact.

export const SENSE_CATEGORIES = [
  { id: "grounding", label: "Screen grounding", detail: "Where something is on screen" },
  { id: "vlm", label: "General vision", detail: "What an image shows" },
  { id: "ocr", label: "OCR", detail: "Text in an image or scanned page" },
  { id: "detection", label: "Object detection", detail: "What + where, real-world imagery" },
];

export const SENSES_CATALOG = [
  // ── Screen grounding ──
  {
    id: "holo2",
    name: "Holo2",
    vendor: "H Company",
    category: "grounding",
    summary: "GUI element grounding built on Qwen3-VL. 30B-A3B: 66.1% ScreenSpot-Pro, 76.1% OSWorld-G. Agentic multi-step localization adds 10-20% relative on small targets in 4K interfaces.",
    license: "Apache-2.0 (4B/8B) · non-commercial (30B-A3B, 235B-A22B)",
    sizes: "4B, 8B, 30B-A3B, 235B-A22B",
    needsEndpoint: true,
  },
  {
    id: "omniparser-v2",
    name: "OmniParser v2",
    vendor: "Microsoft",
    category: "grounding",
    summary: "Detector + icon-captioner pipeline that tokenizes a screenshot into a structured element list any LLM can consume, rather than a single click coordinate. 39.6 avg on ScreenSpot-Pro paired with GPT-4o.",
    license: "MIT (parser) — icon_detect weights are AGPL (inherited from the underlying YOLO model)",
    sizes: "two-model pipeline",
    needsEndpoint: true,
  },
  {
    id: "ui-tars-2",
    name: "UI-TARS-2",
    vendor: "ByteDance",
    category: "grounding",
    summary: "Full desktop-agent loop, not just grounding: 88.2 Online-Mind2Web, 47.5 OSWorld, 73.3 AndroidWorld.",
    license: "Apache-2.0 (UI-TARS-desktop)",
    sizes: "agent stack",
    needsEndpoint: true,
  },
  {
    id: "gui-actor",
    name: "GUI-Actor",
    vendor: "Microsoft (NeurIPS'25)",
    category: "grounding",
    summary: "Attention head over visual patches instead of text-coordinate generation. 7B on a Qwen2.5-VL backbone hits 44.6 ScreenSpot-Pro, beating UI-TARS-72B (38.1). The ~100M-param action head can be trained with the backbone frozen.",
    license: "research release",
    sizes: "7B",
    needsEndpoint: true,
  },

  // ── General vision ──
  {
    id: "qwen3-vl",
    name: "Qwen3-VL",
    vendor: "Alibaba",
    category: "vlm",
    summary: "Default all-round open-weight VLM: long-video localization, strong OCR, 2D/3D grounding, native UI-element recognition. Qwen3.5-122B-A10B currently tops open models on ScreenSpot-Pro at 0.704.",
    license: "Apache-2.0",
    sizes: "4B (~6GB VRAM), 8B, up to 122B-A10B",
    needsEndpoint: true,
  },
  {
    id: "internvl3",
    name: "InternVL3",
    vendor: "OpenGVLab",
    category: "vlm",
    summary: "Strongest MIT-licensed VLM, no use restrictions. 78B variant scores ~72.2% MMMU.",
    license: "MIT",
    sizes: "up to 78B",
    needsEndpoint: true,
  },
  {
    id: "molmo",
    name: "Molmo",
    vendor: "Allen Institute for AI",
    category: "vlm",
    summary: "Genuinely open (weights and training data both released). Distinctive pointing/grounding capability, underrated for pipelines that need a click target, not just a caption.",
    license: "Apache-2.0",
    sizes: "up to 72B",
    needsEndpoint: true,
  },

  // ── OCR ──
  {
    id: "dots-ocr",
    name: "dots.mocr",
    vendor: "rednote-hilab",
    category: "ocr",
    summary: "Currently leads open OCR on olmOCR-Bench, OmniDocBench v1.5, and XDocParse — still behind Gemini 3 Pro. Small: 1.7B.",
    license: "MIT",
    sizes: "1.7B",
    needsEndpoint: true,
  },
  {
    id: "paddleocr-vl",
    name: "PaddleOCR-VL",
    vendor: "Baidu",
    category: "ocr",
    summary: "Native-resolution encoder plus a 0.3B ERNIE decoder, ~0.9B total. Multilingual, mixed scripts, structured tables in one pass. 96.33% OmniDocBench v1.6.",
    license: "Apache-2.0",
    sizes: "~0.9B",
    needsEndpoint: true,
  },
  {
    id: "surya",
    name: "Surya",
    vendor: "VikParuchuri",
    category: "ocr",
    summary: "Small OCR model, good throughput-to-size ratio.",
    license: "GPL-3.0 (code)",
    sizes: "650M",
    needsEndpoint: true,
  },
  {
    id: "paddleocr-classic",
    name: "PaddleOCR (classic)",
    vendor: "Baidu",
    category: "ocr",
    summary: "Non-VLM pipeline for CPU-bound or throughput-sensitive ingestion — ~120 pages/min on an RTX 3090 vs Tesseract's ~25 on CPU.",
    license: "Apache-2.0",
    sizes: "lightweight",
    needsEndpoint: true,
  },
  {
    id: "tesseract",
    name: "Tesseract.js",
    vendor: "Tesseract / naptha",
    category: "ocr",
    summary: "Runs in-browser, no endpoint needed. Already the fallback for scanned PDFs with no text layer — every other sense here is a candidate to replace or supplement it once connected.",
    license: "Apache-2.0",
    sizes: "in-browser",
    needsEndpoint: false,
  },

  // ── Object detection ──
  {
    id: "sam3",
    name: "SAM 3",
    vendor: "Meta",
    category: "detection",
    summary: "Detects and segments every instance of a prompted noun phrase in one pass. Trained on 4M annotated concepts, 270,000 supported at inference — more than double the cgF1 of OWLv2 on open-vocabulary SA-Co/Gold.",
    license: "SAM license (research + commercial use permitted, see Meta's terms)",
    sizes: "single model",
    needsEndpoint: true,
  },
  {
    id: "grounding-dino-sam2",
    name: "Grounding DINO + SAM2",
    vendor: "IDEA-Research / Meta",
    category: "detection",
    summary: "Detector + segmenter combo. Worth it where a specific detector backbone is already the pipeline, or SAM 3 isn't available.",
    license: "Apache-2.0 (Grounding DINO) + SAM license (SAM2)",
    sizes: "two-model pipeline",
    needsEndpoint: true,
  },
];

export function sensesCatalog() {
  return SENSES_CATALOG.map((s) => ({ ...s }));
}
