// Old TS accepts this, but new TS widens it to Uint8Array<ArrayBufferLike>,
// which then fails at BufferSource / WebCrypto calls.
function test1(): Uint8Array {
  return 1 as any;
}

crypto.subtle.digest('SHA-256', test1());

export {};
