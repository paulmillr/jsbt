export const moduleOverview = 1;
export function cloneBytes(msg) {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  return Uint8Array.from(msg);
}
export function acceptCarrier(carrier) {
  if (!carrier || typeof carrier !== 'object')
    throw new TypeError('"carrier" expected object, got type=' + typeof carrier);
  return true;
}
export function returnedCoder(seed) {
  if (!(seed instanceof Uint8Array))
    throw new TypeError('"seed" expected Uint8Array, got type=' + typeof seed);
  return {
    encode(msg) {
      if (!(msg instanceof Uint8Array))
        throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
      return Uint8Array.from([...seed, ...msg]);
    },
  };
}
class ReturnedPoint {
  constructor(msg) {
    if (!(msg instanceof Uint8Array))
      throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
    this.msg = Uint8Array.from(msg);
  }
}
export function returnedClassHolder(seed) {
  if (!(seed instanceof Uint8Array))
    throw new TypeError('"seed" expected Uint8Array, got type=' + typeof seed);
  return { Point: ReturnedPoint };
}
export function combineScoped(msg, sig) {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  if (!(sig instanceof Uint8Array))
    throw new TypeError('"sig" expected Uint8Array, got type=' + typeof sig);
  return Uint8Array.from([...msg, ...sig]);
}
export function nestedPublicCall(msg) {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  return Uint8Array.from(msg);
}
export function commentedOwner(msg) {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  return Uint8Array.from(msg);
}
export class CheckedBox {
  constructor(msg) {
    if (!(msg instanceof Uint8Array))
      throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
    this.msg = Uint8Array.from(msg);
  }
}
export function makeCoder() {
  return {
    encode(msg) {
      if (!(msg instanceof Uint8Array))
        throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
      return Uint8Array.from(msg);
    },
  };
}
export function makeDirectCoder() {
  return makeCoder();
}
export function optionalSeed(seed) {
  if (seed === undefined) return Uint8Array.of(1);
  if (!(seed instanceof Uint8Array))
    throw new TypeError('"seed" expected Uint8Array, got type=' + typeof seed);
  return Uint8Array.from(seed);
}
const aliasBytesDoc = cloneBytes;
export { aliasBytesDoc as aliasBytes };
export const constantTable = /* @__PURE__ */ (() => ({
  value: 1,
  helper: (msg) => msg,
}))();
