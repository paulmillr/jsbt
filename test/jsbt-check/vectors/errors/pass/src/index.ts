/**
 * Module overview/import examples are not runtime validation probes.
 * @module
 * @example
 * Import examples should be ignored by check:errors.
 *
 * ```ts
 * import { cloneBytes } from '@jsbt-test/errors-pass';
 * ```
 */
export const moduleOverview = 1;
/**
 * Copies message bytes.
 * @param msg - Message bytes.
 * @returns Detached byte copy.
 * @example
 * Clone one byte message.
 *
 * ```ts
 * const msg = Uint8Array.of(1, 2, 3);
 * cloneBytes(msg);
 * ```
 */
export function cloneBytes(msg: Uint8Array): Uint8Array {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  return Uint8Array.from(msg);
}
/**
 * Accepts a caller-owned carrier object.
 * @param carrier - Caller-owned carrier object.
 * @returns Whether the carrier is structurally present.
 * @example
 * Accept a carrier object from user code.
 *
 * ```ts
 * const carrier = { bytes: Uint8Array.of(1, 2, 3), valid: true };
 * acceptCarrier(carrier);
 * ```
 */
export function acceptCarrier(carrier: { bytes: Uint8Array; valid: boolean }): boolean {
  if (!carrier || typeof carrier !== 'object')
    throw new TypeError('"carrier" expected object, got type=' + typeof carrier);
  return true;
}
/**
 * Creates a returned object with its own byte boundary.
 * @param seed - Seed bytes.
 * @returns Byte coder object.
 * @example
 * Create a coder; check:errors should probe returned methods too.
 *
 * ```ts
 * returnedCoder(Uint8Array.of(1, 2, 3));
 * ```
 */
export function returnedCoder(seed: Uint8Array): { encode(msg: Uint8Array): Uint8Array } {
  if (!(seed instanceof Uint8Array))
    throw new TypeError('"seed" expected Uint8Array, got type=' + typeof seed);
  return {
    encode(msg: Uint8Array): Uint8Array {
      if (!(msg instanceof Uint8Array))
        throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
      return Uint8Array.from([...seed, ...msg]);
    },
  };
}
class ReturnedPoint {
  msg: Uint8Array;
  constructor(msg: Uint8Array) {
    if (!(msg instanceof Uint8Array))
      throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
    this.msg = Uint8Array.from(msg);
  }
}
/**
 * Creates an object with a class-valued member.
 * @param seed - Seed bytes.
 * @returns Public object that exposes a class constructor.
 * @example
 * Class members on returned objects are constructors, not methods to call directly.
 *
 * ```ts
 * returnedClassHolder(Uint8Array.of(1, 2, 3));
 * ```
 */
export function returnedClassHolder(seed: Uint8Array): { Point: typeof ReturnedPoint } {
  if (!(seed instanceof Uint8Array))
    throw new TypeError('"seed" expected Uint8Array, got type=' + typeof seed);
  return { Point: ReturnedPoint };
}
/**
 * Combines message and signature bytes.
 * @param msg - Message bytes.
 * @param sig - Signature bytes.
 * @returns Detached byte copy.
 * @example
 * Use values created inside a setup block.
 *
 * ```ts
 * if (true) {
 *   const msg = Uint8Array.of(1, 2);
 *   const sig = Uint8Array.of(3, 4);
 *   combineScoped(msg, sig);
 * }
 * ```
 */
export function combineScoped(msg: Uint8Array, sig: Uint8Array): Uint8Array {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  if (!(sig instanceof Uint8Array))
    throw new TypeError('"sig" expected Uint8Array, got type=' + typeof sig);
  return Uint8Array.from([...msg, ...sig]);
}
/**
 * Accepts bytes created by another public helper.
 * @param msg - Message bytes.
 * @returns Detached byte copy.
 * @example
 * Use a public helper inside another public call.
 *
 * ```ts
 * import { cloneBytes, nestedPublicCall } from '@jsbt-test/errors-pass';
 * nestedPublicCall(cloneBytes(Uint8Array.of(1, 2, 3)));
 * ```
 */
export function nestedPublicCall(msg: Uint8Array): Uint8Array {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  return Uint8Array.from(msg);
}
/**
 * Copies message bytes after an internal note.
 * @param msg - Message bytes.
 * @returns Detached byte copy.
 * @example
 * Use the documented function without an explicit import.
 *
 * ```ts
 * const msg = Uint8Array.of(1, 2, 3);
 * commentedOwner(msg);
 * ```
 */
// Real packages sometimes keep internal implementation notes between docs and export.
export function commentedOwner(msg: Uint8Array): Uint8Array {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  return Uint8Array.from(msg);
}
/**
 * Stores message bytes in a wrapper object.
 * @param msg - Message bytes.
 * @example
 * Construct a checked wrapper.
 *
 * ```ts
 * new CheckedBox(Uint8Array.of(1, 2, 3));
 * ```
 */
export class CheckedBox {
  msg: Uint8Array;
  constructor(msg: Uint8Array) {
    if (!(msg instanceof Uint8Array))
      throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
    this.msg = Uint8Array.from(msg);
  }
}
/**
 * Creates a byte coder object.
 * @returns Byte coder object.
 * @example
 * Probe a method on the returned object.
 *
 * ```ts
 * const coder = makeCoder();
 * coder.encode(Uint8Array.of(1, 2, 3));
 * ```
 */
export function makeCoder(): { encode(msg: Uint8Array): Uint8Array } {
  return {
    encode(msg: Uint8Array): Uint8Array {
      if (!(msg instanceof Uint8Array))
        throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
      return Uint8Array.from(msg);
    },
  };
}
/**
 * Creates another byte coder object.
 * @returns Byte coder object.
 * @example
 * Probe a method on a direct factory result.
 *
 * ```ts
 * makeDirectCoder().encode(Uint8Array.of(1, 2, 3));
 * ```
 */
export function makeDirectCoder(): { encode(msg: Uint8Array): Uint8Array } {
  return makeCoder();
}
/**
 * Copies optional seed bytes.
 * @param seed - Optional seed bytes.
 * @returns Detached seed copy.
 * @example
 * Generate a value without passing the optional seed.
 *
 * ```ts
 * optionalSeed();
 * ```
 */
export function optionalSeed(seed?: Uint8Array): Uint8Array {
  if (seed === undefined) return Uint8Array.of(1);
  if (!(seed instanceof Uint8Array))
    throw new TypeError('"seed" expected Uint8Array, got type=' + typeof seed);
  return Uint8Array.from(seed);
}
/**
 * Copies bytes through an exported alias.
 * @param msg - Message bytes.
 * @returns Detached byte copy.
 * @example
 * Use the public alias name.
 *
 * ```ts
 * aliasBytes(Uint8Array.of(1, 2, 3));
 * ```
 */
const aliasBytesDoc: typeof cloneBytes = cloneBytes;
export { aliasBytesDoc as aliasBytes };
/**
 * Constant table with function-valued internals.
 * @example
 * Read from a constant table.
 *
 * ```ts
 * constantTable.value;
 * ```
 */
export const constantTable = /* @__PURE__ */ (() => ({
  value: 1,
  helper: (msg: Uint8Array) => msg,
}))();
