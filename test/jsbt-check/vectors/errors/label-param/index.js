export function normalize(data, errorTitle = '') {
  if (!(data instanceof Uint8Array)) {
    const prefix = errorTitle && `"${errorTitle}" `;
    throw new TypeError(`${prefix}expected Uint8Array, got type=${typeof data}`);
  }
  return new Uint8Array(data);
}
