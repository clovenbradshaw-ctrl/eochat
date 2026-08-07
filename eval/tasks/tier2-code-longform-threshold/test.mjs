// Independently-authored acceptance test, written from the task spec, not
// from eochat's real fix commit. Pins the exact boundary value (3) the real
// bug report describes, plus values on both sides.

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

  check("exports a function named shouldEscalate", () => typeof mod.shouldEscalate === "function");
  check("exports STRUCTURAL_MISMATCH_THRESHOLD unchanged (3)", () => mod.STRUCTURAL_MISMATCH_THRESHOLD === 3);
  if (typeof mod.shouldEscalate !== "function") return { checks };
  const f = mod.shouldEscalate;

  check("REGRESSION (the real reported bug): exactly 3 distinct references DOES escalate", () => f(3) === true);
  check("2 distinct references does NOT escalate", () => f(2) === false);
  check("0 distinct references does NOT escalate", () => f(0) === false);
  check("4 distinct references still escalates (unchanged behavior above the boundary)", () => f(4) === true);
  check("10 distinct references still escalates", () => f(10) === true);

  return { checks };
}
