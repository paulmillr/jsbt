const bytes = (name, value) => {
  if (!(value instanceof Uint8Array)) throw new Error(`${name} expected Uint8Array`);
  return value;
};

export function hiddenFile(data) {
  return new Uint8Array(bytes('hiddenFile data', data));
}
