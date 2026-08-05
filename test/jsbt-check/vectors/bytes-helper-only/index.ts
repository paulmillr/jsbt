import type { CHash, Hash, TArg, TRet } from './utils.ts';

export type WrappedHash = TArg<CHash>;
export declare function useImported(hash: TArg<CHash>): TRet<CHash>;

export declare class Impl implements Hash<Impl> {
  update(buf: TArg<Uint8Array>): this;
  digest(): TRet<Uint8Array>;
  clone(): Impl;
}

export abstract class BaseHash<T extends BaseHash<T>> implements Hash<T> {
  protected buffer: Uint8Array;
  protected constructor() {
    this.buffer = new Uint8Array();
  }
  update(_buf: TArg<Uint8Array>): this {
    return this;
  }
  digest(): TRet<Uint8Array> {
    return new Uint8Array() as TRet<Uint8Array>;
  }
  abstract clone(): T;
}

export class Holder<T extends Hash<T>> {
  state: T;
  hash?: Hash<T>;
  constructor(state: T) {
    this.state = state;
  }
}
