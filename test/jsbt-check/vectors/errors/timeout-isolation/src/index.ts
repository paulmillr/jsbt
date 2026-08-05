/**
 * Never returns after validating its input.
 * @param msg - Message bytes.
 * @returns Never returns.
 * @example
 * This example intentionally hangs after startup.
 *
 * ```ts
 * spin(Uint8Array.of(1));
 * ```
 */
export function spin(msg: Uint8Array): Uint8Array {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  for (;;) {}
}

/**
 * Validates bytes normally.
 * @param msg - Message bytes.
 * @returns Detached byte copy.
 * @example
 * This example should still run after another example times out.
 *
 * ```ts
 * checked(Uint8Array.of(2));
 * ```
 */
export function checked(msg: Uint8Array): Uint8Array {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  return Uint8Array.from(msg);
}
