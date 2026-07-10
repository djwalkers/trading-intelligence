import axe from "axe-core";

// Build 1.13.0 — runs axe-core directly against a jsdom-rendered container rather than a real
// browser. jsdom does no layout/paint, so rules that depend on rendered geometry or computed
// color (notably "color-contrast") can't run meaningfully here and are excluded — see
// docs/product/BUILD-1.13.0.md, "Accessibility scan results" for why, and for the fact that
// contrast itself was already covered by Build 1.12.2's manual, real-browser contrast audit.
const JSDOM_UNSUPPORTED_RULES = ["color-contrast"];

export async function expectNoAxeViolations(container: HTMLElement): Promise<void> {
  const results = await axe.run(container, {
    rules: Object.fromEntries(JSDOM_UNSUPPORTED_RULES.map((id) => [id, { enabled: false }])),
  });

  if (results.violations.length > 0) {
    const summary = results.violations
      .map((violation) => `${violation.id}: ${violation.help} (${violation.nodes.length} node(s))`)
      .join("\n");
    throw new Error(`axe-core found ${results.violations.length} violation(s):\n${summary}`);
  }
}
