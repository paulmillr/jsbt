const bytes = (name, value) => {
  if (!(value instanceof Uint8Array)) throw new Error(`${name} expected Uint8Array`);
  return value;
};

export function publicFn(_label, data) {
  return new Uint8Array(bytes('data', data));
}

export function _hidden(data) {
  return new Uint8Array(bytes('_hidden data', data));
}

export class _Secret {
  constructor(data) {
    bytes('_Secret data', data);
  }
  open(data) {
    return new Uint8Array(bytes('_Secret open data', data));
  }
}

export function makeSecret(data) {
  bytes('data', data);
  return new _Secret(data);
}

export const secretFactory = Object.assign((data) => new Uint8Array(bytes('data', data)), {
  create(data) {
    bytes('data', data);
    return new _Secret(data);
  },
});

export class Box {
  constructor(_seed) {
    bytes('_seed', _seed);
  }
  secret(data) {
    return new Uint8Array(bytes('secret data', data));
  }
  _skip(data) {
    return new Uint8Array(bytes('_skip data', data));
  }
  open(_tag, data) {
    return new Uint8Array(bytes('data', data));
  }
}
