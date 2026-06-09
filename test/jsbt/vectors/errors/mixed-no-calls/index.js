export function randomBytes(bytesLength) {
  if (typeof bytesLength !== 'number')
    throw new Error(`"bytesLength" expected number, got ${typeof bytesLength}`);
  return new Uint8Array(bytesLength);
}

const check = (value) => {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`expected Uint8Array, got type=${typeof value}`);
  }
  return new Uint8Array(value);
};

export const one = check;
export const two = check;
