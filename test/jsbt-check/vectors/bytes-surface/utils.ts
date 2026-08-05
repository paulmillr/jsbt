export type RetU8A = ReturnType<typeof Uint8Array.of>;

type BadOut<T> = {
  oid: Uint8Array;
  encode(data: Uint8Array): T;
  decode(bytes: T): Uint8Array;
};
type GoodOut<T> = {
  oid: RetU8A;
  encode(data: Uint8Array): T;
  decode(bytes: T): RetU8A;
};
type InputRaw<T> = {
  oid: Uint8Array;
  encode(data: Uint8Array): T;
  decode(bytes: T): Uint8Array;
};
type InputRet<T> = {
  oid: Uint8Array;
  encode(data: Uint8Array): T;
  decode(bytes: T): RetU8A;
};

export declare const tmp: BadOut<Uint8Array>;
export declare function tmp2(): BadOut<Uint8Array>;
export declare function good(): GoodOut<Uint8Array>;
export declare function tmp3(arg: InputRaw<Uint8Array>, arg2: InputRet<Uint8Array>): void;
export declare function takesFn(fn: (decode: (bytes: Uint8Array) => Uint8Array) => void): void;
export declare function returnsFn(): (encode: (data: Uint8Array) => RetU8A) => Uint8Array;
