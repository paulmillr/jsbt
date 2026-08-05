let touched = false;

/**
 * Mutates package module state.
 * @param msg - Message bytes.
 * @returns Detached byte copy.
 * @example
 * Dirty the module state inside one public example.
 *
 * ```ts
 * dirty(Uint8Array.of(1));
 * ```
 */
export function dirty(msg: Uint8Array): Uint8Array {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  touched = true;
  return Uint8Array.from(msg);
}

/**
 * Requires a fresh module instance.
 * @param msg - Message bytes.
 * @returns Detached byte copy.
 * @example
 * This probe should not observe another example's module state.
 *
 * ```ts
 * fresh(Uint8Array.of(2));
 * ```
 */
export function fresh(msg: Uint8Array): Uint8Array {
  if (touched) throw new Error('state leaked');
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  return Uint8Array.from(msg);
}
