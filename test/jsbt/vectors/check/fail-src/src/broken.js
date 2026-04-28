const retained = makeValue();

function makeValue() {
  return { ok: true };
}

export const broken = (value) => value + 1;
