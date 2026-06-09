export function check(value) {
  if (!(value instanceof Uint8Array)) throw new TypeError('value expected Uint8Array');
  return new Uint8Array(value);
}
