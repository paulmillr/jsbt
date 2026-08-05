export default function verify(value) {
  if (typeof value !== 'string') throw new Error(`expected value, got ${typeof value}`);
  return value;
}
