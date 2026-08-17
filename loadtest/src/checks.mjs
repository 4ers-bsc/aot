// Collects invariant results so a scenario can assert many things and report
// them all (rather than throwing on the first). A load test that "passes" but
// silently corrupted seats is worthless — these are the real deliverable.

export class Checker {
  constructor(label) {
    this.label = label;
    this.checks = [];
  }
  ok(name, cond, detail = "") {
    this.checks.push({ name, pass: !!cond, detail: String(detail) });
    return !!cond;
  }
  eq(name, actual, expected, extra = "") {
    const pass = actual === expected;
    this.checks.push({
      name,
      pass,
      detail: `${extra}${extra ? " " : ""}got=${actual} want=${expected}`,
    });
    return pass;
  }
  get passed() {
    return this.checks.every((c) => c.pass);
  }
  render() {
    return this.checks
      .map((c) => `    ${c.pass ? "✓" : "✗"} ${c.name}${c.detail ? `  (${c.detail})` : ""}`)
      .join("\n");
  }
}
