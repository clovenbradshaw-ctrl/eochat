// Independently-authored acceptance test — written from the task SPEC above,
// not from eoreader6's real fix commit's diff or its own added test. Mirrors
// the spec's Tier 2 bar: root-caused fix (every shape correctly rejected),
// not a shotgun patch that happens to pass one example.

import { gap, isGap } from "./fixtures/nul-helpers.mjs";

export async function evaluate(candidateUrl) {
  const checks = [];
  const check = (name, fn) => {
    try {
      const ok = fn();
      checks.push({ name, pass: !!ok, message: ok ? "" : "assertion returned false" });
    } catch (err) {
      checks.push({ name, pass: false, message: `threw: ${err.message}` });
    }
  };

  let mod;
  try {
    mod = await import(candidateUrl);
  } catch (err) {
    return { checks: [{ name: "module loads", pass: false, message: `import failed: ${err.message}` }] };
  }

  check("exports a function named admitsRezeroTrigger", () => typeof mod.admitsRezeroTrigger === "function");
  if (typeof mod.admitsRezeroTrigger !== "function") return { checks };
  const f = mod.admitsRezeroTrigger;

  const realTrigger = gap("paradigm_unraveled", { paradigm: ["a"], cores: ["field:x"] });
  check("the real, measured trigger is admitted", () => f(realTrigger) === true);

  check("REGRESSION (the real reported bug): refuseParadigm's routine non-unraveled result is NOT admitted", () =>
    f({ refused: false, paradigm: ["kindA", "kindB"] }) === false);

  check("a gap of a DIFFERENT type is not admitted", () => f(gap("empty_material", {})) === false);

  check("an object merely carrying `unraveled` (old buggy fallback shape) is not admitted", () =>
    f({ unraveled: true, paradigm: ["x"] }) === false);

  check("null is not admitted", () => f(null) === false);
  check("undefined is not admitted", () => f(undefined) === false);
  check("a plain empty object is not admitted", () => f({}) === false);

  check("a gap that merely resembles paradigm_unraveled in shape but fails isGap is not admitted", () =>
    f({ gap: "paradigm_unraveled", paradigm: ["a"] }) === false);

  return { checks };
}
