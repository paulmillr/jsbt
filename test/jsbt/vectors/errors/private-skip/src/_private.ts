/**
 * Private-file helper.
 * @param data - Private-file bytes.
 * @returns Fresh bytes.
 * @example
 * Exercise an exported helper from an underscore-leading source file.
 *
 * ```ts
 * import { hiddenFile } from '@jsbt-test/errors-private-skip/_private.js';
 * hiddenFile(new Uint8Array([1]));
 * ```
 */
export function hiddenFile(data: Uint8Array): Uint8Array {
  throw new Error('runtime fixture is provided by _private.js');
}
