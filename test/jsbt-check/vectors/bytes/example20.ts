type RetU8A = ReturnType<typeof Uint8Array.of>;
type RetDecoder = { decode(bytes: Uint8Array): RetU8A };
type RawDecoder = { decode(bytes: Uint8Array): Uint8Array };

declare const raw: RawDecoder;
const ret: RetDecoder = raw;
void ret;
