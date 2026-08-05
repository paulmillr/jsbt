export function isValidSecretKey(secretKey) {
  return secretKey instanceof Uint8Array;
}
export function badReturnedCoder(seed) {
  if (!(seed instanceof Uint8Array))
    throw new TypeError('"seed" expected Uint8Array, got type=' + typeof seed);
  return {
    encode(msg) {
      return msg;
    },
  };
}
export function vague(secretKey) {
  if (!(secretKey instanceof Uint8Array)) throw new TypeError('bad');
  return Uint8Array.from(secretKey);
}
export function mutates(secretKey) {
  if (!(secretKey instanceof Uint8Array))
    throw new TypeError('"secretKey" expected Uint8Array, got type=' + typeof secretKey);
  secretKey[0] ^= 1;
  return Uint8Array.from(secretKey);
}
export function aliases(secretKey) {
  if (!(secretKey instanceof Uint8Array))
    throw new TypeError('"secretKey" expected Uint8Array, got type=' + typeof secretKey);
  return secretKey;
}
