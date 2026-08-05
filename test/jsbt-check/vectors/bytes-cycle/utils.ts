export type RetU8A = ReturnType<typeof Uint8Array.of>;
export type Coder<F, T> = {
  encode: (from: F) => RetU8A;
  decode: (to: Uint8Array) => F;
  value?: T;
};
export type BytesCoder<T> = Coder<T, RetU8A> & { bytesLen: number };
type UnCoder<T> = T extends BytesCoder<infer U> ? U : never;
type SplitOut<T extends (number | BytesCoder<any>)[]> = {
  [K in keyof T]: T[K] extends number ? number : UnCoder<T[K]>;
};
export function splitCoder<T extends (number | BytesCoder<any>)[]>(
  ..._items: T
): BytesCoder<SplitOut<T>> {
  return undefined as any;
}
export function encode<T extends (number | BytesCoder<any>)[]>(...items: T): RetU8A {
  return splitCoder(...items).encode([] as SplitOut<T>) as RetU8A;
}
