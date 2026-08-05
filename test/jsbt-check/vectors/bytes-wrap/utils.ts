export type RetU8A = ReturnType<typeof Uint8Array.of>;
export type RetU32A = ReturnType<typeof Uint32Array.of>;
export type TArg<T> = T;
export type TRet<T> = T;

type Surface = {
  oid: Uint8Array;
  words: Uint32Array;
  encode(data: Uint8Array): Uint32Array;
  decode(bytes: Uint8Array): Uint8Array;
  nested: { cb: (value: Uint8Array) => Uint8Array };
};

export declare const rawValue: Surface;
export declare const wrappedValue: TRet<Surface>;
export declare function raw(arg: Surface, direct: Uint8Array): Surface;
export declare function wrapped(arg: TArg<Surface>, direct: TArg<Uint8Array>): TRet<Surface>;
export declare function rawPromise(): Promise<Uint8Array>;
export declare function wrappedPromise(): Promise<TRet<Uint8Array>>;
export declare function badPromise(): TRet<Promise<Uint8Array>>;
