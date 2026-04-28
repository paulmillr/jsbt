const retained = makeValue();
const _keep = retained.ok; // This inline comment is intentionally long enough to cross the line limit and should move above the code.

function makeValue() {
  return { ok: true };
}

export const broken = (value: number): number => value + 1;
