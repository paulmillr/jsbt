const bypass = 1;
void bypass;

// This comment is intentionally longer than one hundred characters so the comments checker has a deterministic source issue.
export const raw = 123n;

/** Adds two numbers.
 * @param a - First addend.
 * @param b - Second addend.
 * @returns Sum of both addends.
 * @example
 * Add two numbers.
 * ```ts
 * sum(20, 22);
 * ```
 */
export function sum(a: number, b: number): number {
  return a + b;
}

export function undocumented(value: number): number {
  return value;
}

/** Copies byte input.
 * @param data - Input bytes.
 * @returns The same bytes.
 * @example
 * Copy bytes.
 * ```ts
 * bytes(Uint8Array.of(1, 2, 3));
 * ```
 */
export function bytes(data: Uint8Array): Uint8Array {
  if (!(data instanceof Uint8Array))
    throw new TypeError('"data" expected Uint8Array, got type=' + typeof data);
  return data;
}

/** Example that cannot infer a valid public call.
 * @param data - Input bytes.
 * @returns The same bytes.
 * @example
 * Prepare bytes but do not call the documented function.
 * ```ts
 * const data = Uint8Array.of(1, 2, 3);
 * console.log(data.length);
 * ```
 */
export function unprobeable(data: Uint8Array): Uint8Array {
  if (!(data instanceof Uint8Array))
    throw new TypeError('"data" expected Uint8Array, got type=' + typeof data);
  return data;
}

export const mutable = { count: 0 };
