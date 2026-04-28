export type TypedArg<T> = T extends BigInt64Array
  ? BigInt64Array
  : T extends BigUint64Array
    ? BigUint64Array
    : T extends Float32Array
      ? Float32Array
      : T extends Float64Array
        ? Float64Array
        : T extends Int16Array
          ? Int16Array
          : T extends Int32Array
            ? Int32Array
            : T extends Int8Array
              ? Int8Array
              : T extends Uint16Array
                ? Uint16Array
                : T extends Uint32Array
                  ? Uint32Array
                  : T extends Uint8ClampedArray
                    ? Uint8ClampedArray
                    : T extends Uint8Array
                      ? Uint8Array
                      : never;

export type TypedRet<T> = T extends BigInt64Array
  ? ReturnType<typeof BigInt64Array.of>
  : T extends BigUint64Array
    ? ReturnType<typeof BigUint64Array.of>
    : T extends Float32Array
      ? ReturnType<typeof Float32Array.of>
      : T extends Float64Array
        ? ReturnType<typeof Float64Array.of>
        : T extends Int16Array
          ? ReturnType<typeof Int16Array.of>
          : T extends Int32Array
            ? ReturnType<typeof Int32Array.of>
            : T extends Int8Array
              ? ReturnType<typeof Int8Array.of>
              : T extends Uint16Array
                ? ReturnType<typeof Uint16Array.of>
                : T extends Uint32Array
                  ? ReturnType<typeof Uint32Array.of>
                  : T extends Uint8ClampedArray
                    ? ReturnType<typeof Uint8ClampedArray.of>
                    : T extends Uint8Array
                      ? ReturnType<typeof Uint8Array.of>
                      : never;

export type TArg<T> =
  | T
  | ([TypedArg<T>] extends [never]
      ? T extends (...args: infer A) => infer R
        ? ((...args: { [K in keyof A]: TRet<A[K]> }) => TArg<R>) & {
            [K in keyof T]: T[K] extends (...args: any) => any ? T[K] : TArg<T[K]>;
          }
        : T extends [infer A, ...infer R]
          ? [TArg<A>, ...{ [K in keyof R]: TArg<R[K]> }]
          : T extends readonly [infer A, ...infer R]
            ? readonly [TArg<A>, ...{ [K in keyof R]: TArg<R[K]> }]
            : T extends (infer A)[]
              ? TArg<A>[]
              : T extends readonly (infer A)[]
                ? readonly TArg<A>[]
                : T extends Promise<infer A>
                  ? Promise<TArg<A>>
                  : T extends object
                    ? { [K in keyof T]: TArg<T[K]> }
                    : T
      : TypedArg<T>);

export type TRet<T> = T extends unknown
  ? T &
      ([TypedRet<T>] extends [never]
        ? T extends (...args: infer A) => infer R
          ? ((...args: { [K in keyof A]: TArg<A[K]> }) => TRet<R>) & {
              [K in keyof T]: T[K] extends (...args: any) => any ? T[K] : TRet<T[K]>;
            }
          : T extends [infer A, ...infer R]
            ? [TRet<A>, ...{ [K in keyof R]: TRet<R[K]> }]
            : T extends readonly [infer A, ...infer R]
              ? readonly [TRet<A>, ...{ [K in keyof R]: TRet<R[K]> }]
              : T extends (infer A)[]
                ? TRet<A>[]
                : T extends readonly (infer A)[]
                  ? readonly TRet<A>[]
                  : T extends Promise<infer A>
                    ? Promise<TRet<A>>
                    : T extends object
                      ? { [K in keyof T]: TRet<T[K]> }
                      : T
        : TypedRet<T>)
  : never;

export class Box {
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  read(): Uint8Array {
    return this.bytes;
  }
  write(bytes: Uint8Array): Uint8Array {
    return bytes;
  }
}

export type DeepShape = {
  bytes: Uint8Array;
  words: Uint32Array;
  all: AllTyped;
  maybe?: Uint8Array;
  union: string | Uint8Array;
  list: Uint8Array[];
  tuple: readonly [Uint8Array, { cb: (arg: Uint8Array) => Uint8Array }];
  promise: Promise<Uint8Array>;
  box: Box;
  run(arg: Uint8Array, cb: (next: (inner: Uint8Array) => Uint8Array) => Uint8Array): Uint8Array;
  mixed(cb: (value: Float32Array) => BigInt64Array): Uint8ClampedArray;
  deeper: {
    nested(cb: (again: (bytes: Uint8Array) => Uint8Array) => Uint8Array): Uint8Array;
  };
};

export type AllTyped = {
  bi64: BigInt64Array;
  bu64: BigUint64Array;
  f32: Float32Array;
  f64: Float64Array;
  i16: Int16Array;
  i32: Int32Array;
  i8: Int8Array;
  u16: Uint16Array;
  u32: Uint32Array;
  u8: Uint8Array;
  u8c: Uint8ClampedArray;
};

export class StatefulHash {
  private state = 0;
  bytes: Uint8Array = new Uint8Array();
  digest(): Uint8Array {
    return this.bytes;
  }
  _cloneInto(to: StatefulHash = new StatefulHash()): StatefulHash {
    to.state = this.state;
    return to;
  }
}
export type CHash<T extends StatefulHash = StatefulHash> = {
  (message: Uint8Array): Uint8Array;
  blockLen: number;
  create(): T;
  outputLen: number;
};
export type Field<T> = {
  ZERO: T;
  ONE: T;
  toBytes(value: T): Uint8Array;
  fromBytes(bytes: Uint8Array): T;
};
export declare function api(arg: TArg<DeepShape>): TRet<DeepShape>;
export declare function hashApi(arg: TArg<CHash<StatefulHash>>): TRet<CHash<StatefulHash>>;
export declare function fieldApi<T>(field: TArg<Field<T>>): void;
export declare const sampleArg: TArg<DeepShape>;
export declare const sampleRet: TRet<DeepShape>;
export declare const sampleHashArg: TArg<CHash<StatefulHash>>;
export declare const sampleHashRet: TRet<CHash<StatefulHash>>;

const raw = new Uint8Array();
const raw32 = new Uint32Array();
const ret = Uint8Array.of();
const ret32 = Uint32Array.of();
const rawAll: TArg<AllTyped> = {
  bi64: new BigInt64Array(),
  bu64: new BigUint64Array(),
  f32: new Float32Array(),
  f64: new Float64Array(),
  i16: new Int16Array(),
  i32: new Int32Array(),
  i8: new Int8Array(),
  u16: new Uint16Array(),
  u32: raw32,
  u8: raw,
  u8c: new Uint8ClampedArray(),
};
const retAll: TRet<AllTyped> = {
  bi64: BigInt64Array.of(),
  bu64: BigUint64Array.of(),
  f32: Float32Array.of(),
  f64: Float64Array.of(),
  i16: Int16Array.of(),
  i32: Int32Array.of(),
  i8: Int8Array.of(),
  u16: Uint16Array.of(),
  u32: ret32,
  u8: ret,
  u8c: Uint8ClampedArray.of(),
};
const argHash: TArg<CHash<StatefulHash>> = Object.assign((message: typeof ret) => raw, {
  blockLen: 64,
  create: () => new StatefulHash(),
  outputLen: 32,
});
const retHash: TRet<CHash<StatefulHash>> = Object.assign(
  (message: Uint8Array) => Uint8Array.of(message[0] || 0),
  {
    blockLen: 64,
    create: () => new StatefulHash(),
    outputLen: 32,
  }
);
function acceptsOriginalGeneric<T>(field: Field<T>, value: T): void {
  const arg: TArg<Field<T>> = field;
  fieldApi(field);
  const generic: TArg<T> = value;
  void arg;
  void generic;
}
const arg: TArg<DeepShape> = {
  bytes: raw,
  words: raw32,
  all: rawAll,
  union: raw,
  list: [raw],
  tuple: [raw, { cb: (arg: Uint8Array) => arg }],
  promise: Promise.resolve(raw),
  box: new Box(raw),
  run(
    arg: Uint8Array,
    cb: (
      next: (inner: ReturnType<typeof Uint8Array.of>) => Uint8Array
    ) => ReturnType<typeof Uint8Array.of>
  ) {
    cb((inner: Uint8Array) => Uint8Array.of(inner[0] || 0));
    return arg;
  },
  // The callback crosses two function boundaries, so polarity flips twice here.
  mixed(cb: (value: Float32Array) => ReturnType<typeof BigInt64Array.of>) {
    cb(Float32Array.of());
    return Uint8ClampedArray.of();
  },
  deeper: {
    nested(
      cb: (
        again: (bytes: ReturnType<typeof Uint8Array.of>) => Uint8Array
      ) => ReturnType<typeof Uint8Array.of>
    ) {
      cb((bytes: Uint8Array) => Uint8Array.of(bytes[0] || 0));
      return raw;
    },
  },
};
const outBox: TRet<Box> = {
  bytes: ret,
  read: () => ret,
  write: (bytes: Uint8Array) => Uint8Array.of(bytes[0] || 0),
};
const out: TRet<DeepShape> = {
  bytes: ret,
  words: ret32,
  all: retAll,
  maybe: ret,
  union: ret,
  list: [ret],
  tuple: [ret, { cb: (arg: Uint8Array) => Uint8Array.of(arg[0] || 0) }],
  promise: Promise.resolve(ret),
  box: outBox,
  run(
    arg: Uint8Array,
    cb: (next: (inner: Uint8Array) => ReturnType<typeof Uint8Array.of>) => Uint8Array
  ) {
    cb((inner: Uint8Array) => Uint8Array.of(inner[0] || 0));
    return Uint8Array.of(arg[0] || 0);
  },
  mixed(cb: (value: ReturnType<typeof Float32Array.of>) => BigInt64Array) {
    cb(Float32Array.of());
    return Uint8ClampedArray.of();
  },
  deeper: {
    nested(cb: (again: (bytes: Uint8Array) => ReturnType<typeof Uint8Array.of>) => Uint8Array) {
      cb((bytes: Uint8Array) => Uint8Array.of(bytes[0] || 0));
      return ret;
    },
  },
};
const produced = api(arg);
const takeRaw = (_arg: Uint8Array): void => {};
const argUnionString: TArg<string | Uint8Array | undefined> = 'ok';
const argUnionU8A: TArg<string | Uint8Array | undefined> = raw;
const argUnionUndefined: TArg<string | Uint8Array | undefined> = undefined;
const retUnionString: TRet<string | Uint8Array | undefined> = 'ok';
const retUnionU8A: TRet<string | Uint8Array | undefined> = ret;
const retUnionUndefined: TRet<string | Uint8Array | undefined> = undefined;
const hashed = hashApi(argHash);
const hashOut = retHash.create().digest();
takeRaw(produced.bytes);
takeRaw(out.bytes);
takeRaw(hashed(Uint8Array.of()));
takeRaw(hashed.create().bytes);
takeRaw(hashOut);
void [
  sampleArg,
  sampleRet,
  sampleHashArg.blockLen,
  sampleHashRet.outputLen,
  produced,
  out,
  argHash.create().bytes,
  retHash.blockLen,
  rawAll,
  retAll,
  argUnionString,
  argUnionU8A,
  argUnionUndefined,
  retUnionString,
  retUnionU8A,
  retUnionUndefined,
];
