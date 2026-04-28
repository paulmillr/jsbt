/**
 * Copies bytes from a source-only public entry.
 * @param msg - Message bytes.
 * @returns Detached byte copy.
 * @example
 * Import from a public entry whose built JS is absent in the checkout.
 *
 * ```ts
 * import { sourceOnly } from '@jsbt-test/errors-pass/source.js';
 * sourceOnly(Uint8Array.of(1, 2, 3));
 * ```
 */
export function sourceOnly(msg: Uint8Array): Uint8Array {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  return Uint8Array.from(msg);
}
