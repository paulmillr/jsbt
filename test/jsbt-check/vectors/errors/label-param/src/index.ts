/**
 * Normalizes bytes.
 * @param data - user bytes.
 * @param errorTitle - label included in thrown errors.
 * @returns copied bytes.
 * @example
 * ```js
 * import { normalize } from '@jsbt-test/errors-label-param';
 * normalize(new Uint8Array([1]));
 * ```
 */
export function normalize(data: Uint8Array, errorTitle = ''): Uint8Array {
  return data;
}
