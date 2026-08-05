const bytes = (value, label) => {
  if (!(value instanceof Uint8Array))
    throw new TypeError(`"${label}" expected Uint8Array, got type=${typeof value}`);
  return value;
};

const options = (opts) => {
  if (!opts || typeof opts !== 'object' || Array.isArray(opts))
    throw new TypeError('"opts" expected object');
  if (opts.dkLen !== undefined) {
    if (typeof opts.dkLen !== 'number')
      throw new TypeError(`"dkLen" expected number, got ${typeof opts.dkLen}`);
    if (!Number.isInteger(opts.dkLen)) throw new TypeError('"dkLen" expected integer');
  }
  if (opts.personalization !== undefined) bytes(opts.personalization, 'personalization');
  if (opts.onProgress !== undefined && typeof opts.onProgress !== 'function')
    throw new TypeError(`"onProgress" expected function, got ${typeof opts.onProgress}`);
  return opts;
};

export const hash = (msg, opts = {}) => {
  return hash.create(opts).update(msg).digest();
};

hash.create = (opts = {}) => {
  options(opts);
  return {
    update(msg) {
      bytes(msg, 'msg');
      return this;
    },
    digest() {
      return new Uint8Array(opts.dkLen || 4);
    },
  };
};

export const mac = (key, message, personalization, dkLen = 4) => {
  bytes(key, 'key');
  bytes(message, 'message');
  bytes(personalization, 'personalization');
  if (typeof dkLen !== 'number')
    throw new TypeError(`"dkLen" expected number, got ${typeof dkLen}`);
  return hash(key, { dkLen, personalization: hash(message, { personalization }) });
};
