# Bytes Compatibility Probes

These examples lock the typed-array compatibility issue across old and new TypeScript releases.
`Ret*` aliases are intentionally named as return-only types.

Expected results:

- `example1.ts`
  - TS `5.6.3`: pass
  - TS `6.0.2`: fail
- `example2.ts`
  - TS `5.6.3`: fail
  - TS `6.0.2`: pass
- `example3.ts`
  - TS `5.6.3`: pass
  - TS `6.0.2`: pass
- `example4.ts`
  - TS `5.6.3`: pass
  - TS `6.0.2`: fail
- `example5.ts`
  - TS `5.6.3`: pass
  - TS `6.0.2`: fail
- `example6.ts`
  - TS `5.6.3`: pass
  - TS `6.0.2`: pass
- `example7.ts`
  - TS `5.6.3`: pass
  - TS `6.0.2`: fail
- `example8.ts`
  - TS `5.6.3`: pass
  - TS `6.0.2`: pass
- `example9.ts`
  - TS `5.6.3`: pass
  - TS `6.0.2`: pass
- `example10.ts`
  - TS `5.6.3`: fail
  - TS `6.0.2`: pass
- `example11.ts`
  - TS `5.6.3`: pass
  - TS `6.0.2`: pass
- `example12.ts`
  - TS `5.6.3`: fail
  - TS `6.0.2`: pass
- `example13.ts`
  - TS `5.6.3`: pass
  - TS `6.0.2`: pass
- `example14.ts`
  - TS `5.6.3`: pass
  - TS `6.0.2`: pass
- `example15.ts`
  - TS `5.6.3`: pass
  - TS `6.0.2`: pass
- `example16.ts`
  - TS `5.6.3`: pass
  - TS `6.0.2`: pass
- `example17.ts`
  - TS `5.6.3`: pass
  - TS `6.0.2`: pass
- `example18.ts`
  - TS `5.6.3`: pass
  - TS `6.0.2`: pass
- `args.ts`
  - TS `5.6.3`: fail because typed arrays are not generic there
  - TS `6.0.2`: fail only on narrow `RetU8A` / `Uint8Array<ArrayBuffer>` parameter calls
- `convert.ts`
  - TS `5.6.3`: fail because typed arrays are not generic there
  - TS `6.0.2`: pass

Per-version installs live in `ts-5.6.3/` and `ts-6.0.2/`.

`boundary/producer.ts` and `boundary/consumer.ts` are also tested through an emitted `.d.ts`
package boundary across the full producer/consumer version matrix:

- producer TS `5.6.3` -> consumer TS `5.6.3`
- producer TS `5.6.3` -> consumer TS `6.0.2`
- producer TS `6.0.2` -> consumer TS `5.6.3`
- producer TS `6.0.2` -> consumer TS `6.0.2`
