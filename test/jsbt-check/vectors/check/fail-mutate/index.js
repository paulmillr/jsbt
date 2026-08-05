export const add = (a, b) => a + b;
export const bytes = new Uint8Array([1, 2, 3]);
export const frozenArray = Object.freeze([1, 2, 3]);
export const frozenObject = Object.freeze({ ok: true });
export const frozenShallow = Object.freeze({
  nestedArray: [1, 2, 3],
  nestedBytes: new Uint8Array([1, 2, 3]),
  nestedObject: { ok: true },
});
export const mutableArray = [1, 2, 3];
export const mutableObject = { ok: true };
export const words = new Uint32Array([1, 2, 3]);
