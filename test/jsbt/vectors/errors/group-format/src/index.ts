/**
 * Checks one byte array.
 * @param msg - message bytes.
 * @returns checked bytes.
 * @example
 * ```js
 * import { one } from '@jsbt-test/errors-group-format';
 * one(new Uint8Array([1]));
 * ```
 */
export function one(msg: Uint8Array): Uint8Array {
  return msg;
}

/**
 * Checks another byte array.
 * @param msg - message bytes.
 * @returns checked bytes.
 * @example
 * ```js
 * import { two } from '@jsbt-test/errors-group-format';
 * two(new Uint8Array([2]));
 * ```
 */
export function two(msg: Uint8Array): Uint8Array {
  return msg;
}
