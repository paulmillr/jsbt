const start = Date.now();
while (Date.now() - start < 20) {}

export function sum(a, b) {
  return a + b;
}

export function undocumented(value) {
  return value;
}

export function bytes(data) {
  if (!(data instanceof Uint8Array))
    throw new TypeError('"data" expected Uint8Array, got type=' + typeof data);
  return data;
}

export function unprobeable(data) {
  if (!(data instanceof Uint8Array))
    throw new TypeError('"data" expected Uint8Array, got type=' + typeof data);
  return data;
}

export const mutable = { count: 0 };
export const raw = 123n;
