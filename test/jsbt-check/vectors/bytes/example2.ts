// New TS accepts explicit ArrayBuffer-backed bytes, but old TS rejects generic typed arrays.
function test2(): Uint8Array<ArrayBuffer> {
  return 1 as any;
}

crypto.subtle.digest('SHA-256', test2());

export {};
