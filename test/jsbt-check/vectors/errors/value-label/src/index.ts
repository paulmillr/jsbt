/**
 * Checks a generic validator value.
 * @param value - value to validate.
 * @returns checked bytes.
 * @example
 * ```js
 * import { check } from '@jsbt-test/errors-value-label';
 * check(new Uint8Array([1]));
 * ```
 */
export function check(value: Uint8Array): Uint8Array {
  return value;
}
