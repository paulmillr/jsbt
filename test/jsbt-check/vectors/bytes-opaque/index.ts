export type Bytes = Uint8Array;

export interface Point<P extends Point<P>> {
  add(rhs: P): P;
  toBytes(): Bytes;
}
export interface PointCons<P extends Point<P>> {
  new (): P;
  BASE: P;
  fromBytes(bytes: Bytes): P;
}
export type FrostOpts<P extends Point<P>> = {
  readonly name: string;
  readonly Point: PointCons<P>;
  readonly parsePublicKey?: (bytes: Uint8Array) => P;
  readonly hash: (msg: Uint8Array) => Uint8Array;
  readonly adjustPoint?: (p: P) => P;
};
export type H2CHasher<PC extends PointCons<any>> = {
  /** Runtime point constructor is an opaque domain object, not a byte DTO. */
  Point: PC;
  defaults: { DST: Uint8Array };
  hashToCurve(msg: Uint8Array): InstanceType<PC>;
};
export class ConcretePoint implements Point<ConcretePoint> {
  static BASE = new ConcretePoint();
  static fromBytes(_bytes: Bytes): ConcretePoint {
    return new ConcretePoint();
  }
  add(_rhs: ConcretePoint): ConcretePoint {
    return new ConcretePoint();
  }
  toBytes(): Bytes {
    return new Uint8Array();
  }
}
export type PlainSurface = {
  defaults: { DST: Uint8Array };
  hash(msg: Uint8Array): Uint8Array;
};
export interface GenericSurface<T> {
  value: T;
  bytes: Uint8Array;
}
export interface Field<T> {
  ZERO: T;
  toBytes(value: T): Uint8Array;
  fromBytes(bytes: Uint8Array): T;
}

export function createFROST<P extends Point<P>>(opts: FrostOpts<P>): void {
  void opts;
}
export function createHasher<PC extends PointCons<any>>(_Point: PC): H2CHasher<PC> {
  return 1 as any;
}
export function createConcreteHasher(): H2CHasher<typeof ConcretePoint> {
  return 1 as any;
}
export function createPlain(): PlainSurface {
  return 1 as any;
}
export function createGeneric(): GenericSurface<string> {
  return 1 as any;
}
export function useField<T>(field: Field<T>): Field<T> {
  return field;
}
export function direct(bytes: Uint8Array): Uint8Array {
  return bytes;
}
