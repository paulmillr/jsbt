/**
 * Returns random bytes.
 * @param bytesLength - byte count.
 * @returns random bytes.
 * @example
 * ```js
 * import { randomBytes } from '@jsbt-test/errors-mixed-no-calls';
 * randomBytes(16);
 * ```
 */
export function randomBytes(bytesLength: number): Uint8Array {
  return new Uint8Array(bytesLength);
}

/**
 * Uses random bytes in docs but has no probeable public call.
 * @param msg - message bytes.
 * @returns checked bytes.
 * @example
 * ```js
 * import { one, randomBytes } from '@jsbt-test/errors-mixed-no-calls';
 * const msg = randomBytes(32);
 * const ref = one;
 * ```
 */
export function one(msg: Uint8Array): Uint8Array {
  return msg;
}

/**
 * Checks a byte array.
 * @param msg - message bytes.
 * @returns checked bytes.
 * @example
 * ```js
 * import { two } from '@jsbt-test/errors-mixed-no-calls';
 * two(new Uint8Array([2]));
 * ```
 */
export function two(msg: Uint8Array): Uint8Array {
  return msg;
}
