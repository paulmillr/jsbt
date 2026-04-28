/**
 * Checks secret-key byte shape.
 * @param secretKey - Secret key bytes.
 * @returns Whether the bytes are a valid secret key.
 * @example
 * Check a valid secret key.
 *
 * ```ts
 * isValidSecretKey(Uint8Array.of(1, 2, 3));
 * ```
 */
export function isValidSecretKey(secretKey: Uint8Array): boolean {
  return secretKey instanceof Uint8Array;
}
/**
 * Creates a returned object that forgets to validate its method input.
 * @param seed - Seed bytes.
 * @returns Byte coder object.
 * @example
 * Create a bad returned coder.
 *
 * ```ts
 * badReturnedCoder(Uint8Array.of(1, 2, 3));
 * ```
 */
export function badReturnedCoder(seed: Uint8Array): { encode(msg: Uint8Array): Uint8Array } {
  if (!(seed instanceof Uint8Array))
    throw new TypeError('"seed" expected Uint8Array, got type=' + typeof seed);
  return {
    encode(msg: Uint8Array): Uint8Array {
      return msg;
    },
  };
}
/**
 * Copies secret-key bytes with a vague error message.
 * @param secretKey - Secret key bytes.
 * @returns Detached byte copy.
 * @example
 * Copy a valid secret key.
 *
 * ```ts
 * vague(Uint8Array.of(1, 2, 3));
 * ```
 */
export function vague(secretKey: Uint8Array): Uint8Array {
  if (!(secretKey instanceof Uint8Array)) throw new TypeError('bad');
  return Uint8Array.from(secretKey);
}
/**
 * Accidentally mutates secret-key bytes.
 * @param secretKey - Secret key bytes.
 * @returns Detached byte copy.
 * @example
 * Mutate bug probe.
 *
 * ```ts
 * import { mutates } from '@jsbt-test/errors-fail';
 * const secretKey = Uint8Array.of(1, 2, 3);
 * mutates(secretKey);
 * ```
 */
export function mutates(secretKey: Uint8Array): Uint8Array {
  if (!(secretKey instanceof Uint8Array))
    throw new TypeError('"secretKey" expected Uint8Array, got type=' + typeof secretKey);
  secretKey[0] ^= 1;
  return Uint8Array.from(secretKey);
}
/**
 * Accidentally returns the caller buffer.
 * @param secretKey - Secret key bytes.
 * @returns Secret key bytes.
 * @example
 * Returned-buffer bug probe.
 *
 * ```ts
 * import { aliases } from '@jsbt-test/errors-fail';
 * const secretKey = Uint8Array.of(1, 2, 3);
 * aliases(secretKey);
 * ```
 */
export function aliases(secretKey: Uint8Array): Uint8Array {
  if (!(secretKey instanceof Uint8Array))
    throw new TypeError('"secretKey" expected Uint8Array, got type=' + typeof secretKey);
  return secretKey;
}
