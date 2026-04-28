// Broad byte input can be normalized before WebCrypto / BufferSource calls.
type RetU8A = ReturnType<typeof Uint8Array.of>;

declare const plain: Uint8Array;
declare const shared: Uint8Array<SharedArrayBuffer>;

const a: RetU8A = Uint8Array.from(plain);
const b: RetU8A = Uint8Array.from(shared);
const c: RetU8A = plain.slice();
const d: RetU8A = shared.slice();

void [a, b, c, d];
export {};
