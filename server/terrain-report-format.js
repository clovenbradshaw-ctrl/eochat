// terrain-report-format.js — pure text formatting for the terrain_report
// tool handler (server/proxy.js), split out so it can be unit-tested
// directly (scripts/check-laws.mjs's L7 check) without needing a live
// proxy or a model round-trip. proxy.js starts an HTTP server as a side
// effect of module load, so importing it just to test one handler's text
// output is not viable — this file has no side effects and no other
// dependency, so importing it is safe from any caller.
//
// LAWS.md L7 — "Signal detected: NO (dominant: Void)" alone reads as a
// considered finding about the SOURCE ("this passage is about nothing/
// absence"). For the cube classifier specifically it can just as easily
// mean the classifier's English-only keyword lexicon (cube/index.js —
// ported from an English wiki-terrain classifier, disclosed in its own
// header) has no terms that can fire on this content at all — a scope
// limit, not a finding. Measured directly: real ancient Greek scores
// exactly this "Void" result (see ORGAN-STACK-REAL-DEPLOYMENT.md), and an
// unqualified line did not tell a reader which of the two they were
// looking at. The classifier cannot tell the difference itself (no
// language ID here, and building one would be a much bigger, separate
// change) — so every no-signal result discloses the ambiguity explicitly
// instead of silently picking the reading that looks like a real finding.

/**
 * formatTerrainReport(report, gate, path) -> string
 *
 * report: the engine's terrain_report object ({ medium, covered, uncovered, evidence }).
 * gate: the engine's born_gate object ({ signalDetected }).
 * path: the source path being reported on (for the header line only).
 */
export function formatTerrainReport(report, gate, path) {
  if (!report) return `[No terrain report available for ${path}]`;

  const scopeCaveat = gate?.signalDetected
    ? ""
    : ` — this classifier's terrain lexicon is English-only (see cube/index.js); ` +
      `"no signal" here cannot be distinguished from "outside this classifier's competence" ` +
      `(e.g. non-English source text) without a separate language check this tool does not perform. ` +
      `Do not read this as a claim that the source itself lacks structure.`;

  const lines = [
    `Terrain Report for: ${path}`,
    `Medium: ${report.medium}`,
    `Signal detected: ${gate?.signalDetected ? "YES" : "NO"}${gate?.signalDetected ? "" : " (dominant: Void)" + scopeCaveat}`,
    `Covered (${report.covered?.length ?? 0}/9): ${(report.covered ?? []).join(", ") || "none"}`,
    `Uncovered: ${(report.uncovered ?? []).join(", ") || "none"}`,
    ``,
  ];

  const ev = report.evidence ?? {};
  if (ev.states != null) lines.push(`States: ${ev.states}`);
  if (ev.events != null) lines.push(`Events: ${ev.events}`);
  if (ev.categories != null) lines.push(`Categories: ${ev.categories}`);
  if (ev.associations != null) lines.push(`Associations: ${ev.associations}`);
  if (ev.voids != null) lines.push(`Voids: ${ev.voids}`);
  if (ev.paradigms != null) lines.push(`Paradigms: ${ev.paradigms}`);
  if (ev.atmospheres != null) lines.push(`Atmosphere descriptors: ${ev.atmospheres}`);
  if (ev.lenses != null) lines.push(`Lens characteristics: ${ev.lenses}`);
  if (ev.holonicLevels) lines.push(`Holonic: states=${ev.holonicLevels.states}, events=${ev.holonicLevels.events}, phases=${ev.holonicLevels.phases}`);
  if (ev.dominantTerrain) lines.push(`Dominant terrain: ${ev.dominantTerrain}`);
  if (ev.dominantStance) lines.push(`Dominant stance: ${ev.dominantStance}`);
  if (ev.classifier) lines.push(`Classifier: ${ev.classifier}`);
  if (ev.terrainAmplitudes) {
    const top = ev.terrainAmplitudes
      .filter((a) => a.amplitude > 0.01)
      .sort((a, b) => b.amplitude - a.amplitude)
      .slice(0, 5);
    if (top.length) lines.push(`Top terrain amplitudes: ${top.map((t) => `${t.label}=${t.amplitude.toFixed(3)}`).join(", ")}`);
  }

  return lines.join("\n");
}
