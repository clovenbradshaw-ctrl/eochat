// Estimates what this eval's local-model latency would look like on a
// MacBook Air (Apple Silicon, Metal GPU) instead of this sandbox's real
// hardware — which is CPU-only (Ollama itself reported "Unable to detect
// NVIDIA/AMD GPU" at install time; `lscpu` shows a 4-core Xeon with no GPU).
// This is a disclosed ESTIMATE, not a live measurement — there is no GPU to
// benchmark against here.
//
// Method: calibrate this SAME model's real generation throughput (tokens/sec)
// on THIS sandbox's CPU, live, via calibrateLocalTokensPerSec() below — never
// a hardcoded number for "this environment," since that would silently rot
// the moment the eval runs somewhere else. Apply a speedup RANGE (not a
// point estimate) drawn from publicly reported Ollama/llama.cpp benchmarks
// for 3B-class Q4 models on an M2 MacBook Air, to convert the measured
// CPU-generation time into an estimated GPU-generation time range.
//
// Sources for the Apple-Silicon side (accessed 2026-08-08, via WebSearch):
//   https://modelpiper.com/blog/ollama-multi-model-mac
//     — "On an M2 MacBook Air, a 3B model generates 50-80 tokens per second"
//   https://hybrid-llm.com/tutorial/benchmarks/best-local-llm-models-mac/
//     — "expect 50-80 tok/s on 3B models on M1/M2 MacBook Air configurations"
// Both are third-party benchmark aggregations, not a benchmark this eval ran
// itself — treat the resulting estimate as a plausible range, not a
// verified number, and re-derive it if a real Apple-Silicon run ever
// becomes available (at which point this whole module is unnecessary).
export const MACBOOK_AIR_M2_3B_TOKENS_PER_SEC = Object.freeze({
  low: 50,
  high: 80,
  source: "ModelPiper / HybridLLM.dev public Ollama benchmark aggregations for 3B-class Q4 models on M2 MacBook Air, accessed 2026-08-08 — not measured by this eval",
});

/**
 * Real, live calibration of THIS model's generation throughput on THIS
 * machine — run a couple of warm-up calls (discarded) then a measured call,
 * and return real tokens/sec from Ollama's own reported eval_duration. This
 * is what makes the GPU estimate self-correcting: if this ever runs on
 * actual Apple-Silicon GPU hardware, the "estimate" becomes redundant with
 * the real measured number rather than silently wrong.
 */
export async function calibrateLocalTokensPerSec(adapter, { warmups = 1, samples = 2, maxTokens = 200 } = {}) {
  const prompt = [{ role: "user", content: "Explain in a few sentences how a compressor high-pressure cut-out (HPCO) works on a commercial refrigeration unit." }];
  for (let i = 0; i < warmups; i++) {
    await adapter.generate(prompt, { maxTokens });
  }
  const rates = [];
  for (let i = 0; i < samples; i++) {
    const r = await adapter.generate(prompt, { maxTokens });
    if (r.timingNs?.eval && r.usage?.output_tokens) {
      rates.push(r.usage.output_tokens / (r.timingNs.eval / 1e9));
    }
  }
  if (!rates.length) return null;
  return rates.reduce((a, b) => a + b, 0) / rates.length;
}

/**
 * Convert a real measured CPU wall-clock time (this sandbox) into an
 * estimated Apple-Silicon-GPU wall-clock RANGE, scaled by the ratio between
 * the calibrated local tok/s and the cited MacBook Air tok/s range. Returns
 * null if calibration wasn't available (never silently substitutes a guess).
 */
export function estimateGpuMs(measuredWallMs, calibratedCpuTokPerSec) {
  if (!measuredWallMs || !calibratedCpuTokPerSec) return null;
  // Faster GPU tok/s (high) -> proportionally lower estimated ms.
  const fastMs = measuredWallMs * (calibratedCpuTokPerSec / MACBOOK_AIR_M2_3B_TOKENS_PER_SEC.high);
  const slowMs = measuredWallMs * (calibratedCpuTokPerSec / MACBOOK_AIR_M2_3B_TOKENS_PER_SEC.low);
  return { fastMs: Math.round(fastMs), slowMs: Math.round(slowMs) };
}
