export function merge(defaults, opts) {
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    throw new TypeError('defaults expected object');
  }
  if (opts !== undefined && (!opts || typeof opts !== 'object' || Array.isArray(opts))) {
    throw new TypeError('opts expected object or undefined');
  }
  return Object.assign(defaults, opts);
}
