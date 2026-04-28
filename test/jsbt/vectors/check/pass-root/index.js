export const add = (a, b) => a + b;
export const wrappedBytes = (value) => value;
export const aliasDocumented = (value) => value;
export function createWrapped(seed) {
  return (value) => new Uint8Array([value[0] || seed]);
}
