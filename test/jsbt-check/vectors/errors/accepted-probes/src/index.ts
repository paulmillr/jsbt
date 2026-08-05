/**
 * Accepts one byte array.
 * @param msg - message bytes.
 * @returns checked bytes.
 * @example
 * ```js
 * import { one } from '@jsbt-test/errors-accepted-probes';
 * one(new Uint8Array([1]));
 * ```
 */
export function one(msg: Uint8Array): Uint8Array {
  return msg;
}

/**
 * Accepts another byte array.
 * @param msg - message bytes.
 * @returns checked bytes.
 * @example
 * ```js
 * import { two } from '@jsbt-test/errors-accepted-probes';
 * two(new Uint8Array([2]));
 * ```
 */
export function two(msg: Uint8Array): Uint8Array {
  return msg;
}
