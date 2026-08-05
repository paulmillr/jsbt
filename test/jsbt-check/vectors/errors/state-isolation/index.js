let touched = false;

export function dirty(msg) {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  touched = true;
  return Uint8Array.from(msg);
}

export function fresh(msg) {
  if (touched) throw new Error('state leaked');
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  return Uint8Array.from(msg);
}
