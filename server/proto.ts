import crypto from 'node:crypto';

export const AES_KEY = Buffer.from([89, 103, 38, 116, 99, 37, 68, 69, 117, 104, 54, 37, 90, 99, 94, 56]);
export const AES_IV = Buffer.from([54, 111, 121, 90, 68, 114, 50, 50, 69, 51, 121, 99, 104, 106, 77, 37]);
export const KEYSTREAM = Buffer.from([
  0x30, 0x30, 0x30, 0x32, 0x30, 0x31, 0x37, 0x30,
  0x30, 0x30, 0x30, 0x30, 0x32, 0x30, 0x31, 0x37,
  0x30, 0x30, 0x30, 0x30, 0x30, 0x32, 0x30, 0x31,
  0x37, 0x30, 0x30, 0x30, 0x30, 0x30, 0x32, 0x30,
]);
export const HEX_KEY = '2ee44819e9b4598845141067b281621874d0d5d7af9d8f7e00c1e54715b7d1e3';
export const API_KEY = Buffer.from(HEX_KEY, 'utf8');

export const GGRE_RAW = Buffer.from(
  '47475245010101006d020000b260ee08e1f86b4c57f9c70f86bba26ed5d1436bcf52e142db3249d905eded757764991ca31a8373cdd26eab91b80f3f1f6f262f4f10b895d7b6937ddba30a27197453890e9da49373f736c679b8254e2f8e1623e91084a5fdd5374fe478ff99e010834553fddeb0bec4018d142e49df9bb236675b67e852f92a43586f7a7d4d0d7a197a1d4da32714dab4d069ad53214e2c33b3877420a12459738c4c619cbd815fa878bbd104776bb3e1ac7818d5397b04a666ac57f682763ff2df31bc2f846ddc7904f3dce1bda0c4b01f9698e9166f98c84f92640abe3f6317834a42e5c12573b46842c1a6ea8fe6ca9c006dca48a2087e1f983dfb5692771e4a0b15b337ad669b1d08b40862b176bace5331b49a767375b1a8469012aa70a67b55fe71b72478201d0b3ac7269c064c960361e92ee7ba8a42cc6b582bf9b965fb388fa9172ad44c4b073ac23c02080a6bcd106b691ffdf4c7cf71e42f2063fcf196e9bddc5e85be1fe5048eb1b31b460efbb46d76195eef9904c4cba326f2e17ff51fec17dd965aa06dadd4ab07d6966e4a7c38e8afd66dfde56c872bb87516a8f7313c797e4d80e5ad4a5f7afad95c1e0449254adae052e71a3fb98399f93ab30848e0d23252dd45e6fd41bc5fa7303dfb846a8fd713a0032a0b0ae96dfba1bbe41d20abd8099e2cb7fccc329d25bd153029139ef05d090a5093ea557693c0a8d491395b8a23ca844b3887dd5dfc29ac06f4b9be87883a793211b973465e2644c4f5de02b8ab01571401203fc2740423826858cc6da0194c195d27aac4ec4b9d23d506c1501d06440aca3fc180926d75d4a004d3dff21eb4ea1e8c86e6c9627248eff953e1d192d5c8efc006a7e512388ef2ebdb72ee3ad42d719f28e8f994e12ebf4c79f2ffe3abd7408ccd2236a7b89b2606247a732c10c4',
  'hex',
);

export const CRC7_TABLE = Buffer.from([
  0, 9, 18, 27, 36, 45, 54, 63, 72, 65, 90, 83, 108, 101, 126, 119,
  25, 16, 11, 2, 61, 52, 47, 38, 81, 88, 67, 74, 117, 124, 103, 110,
  50, 59, 32, 41, 22, 31, 4, 13, 122, 115, 104, 97, 94, 87, 76, 69,
  43, 34, 57, 48, 15, 6, 29, 20, 99, 106, 113, 120, 71, 78, 85, 92,
  100, 109, 118, 127, 64, 73, 82, 91, 44, 37, 62, 55, 8, 1, 26, 19,
  125, 116, 111, 102, 89, 80, 75, 66, 53, 60, 39, 46, 17, 24, 3, 10,
  86, 95, 68, 77, 114, 123, 96, 105, 30, 23, 12, 5, 58, 51, 40, 33,
  79, 70, 93, 84, 107, 98, 121, 112, 7, 14, 21, 28, 35, 42, 49, 56,
  65, 72, 83, 90, 101, 108, 119, 126, 9, 0, 27, 18, 45, 36, 63, 54,
  88, 81, 74, 67, 124, 117, 110, 103, 16, 25, 2, 11, 52, 61, 38, 47,
  115, 122, 97, 104, 87, 94, 69, 76, 59, 50, 41, 32, 31, 22, 13, 4,
  106, 99, 120, 113, 78, 71, 92, 85, 34, 43, 48, 57, 6, 15, 20, 29,
  37, 44, 55, 62, 1, 8, 19, 26, 109, 100, 127, 118, 73, 64, 91, 82,
  60, 53, 46, 39, 24, 17, 10, 3, 116, 125, 102, 111, 80, 89, 66, 75,
  23, 30, 5, 12, 51, 58, 33, 40, 95, 86, 77, 68, 123, 114, 105, 96,
  14, 7, 28, 21, 42, 35, 56, 49, 70, 79, 84, 93, 98, 107, 112, 121,
]);

export function generateSignature(payloadStr: string): string {
  return crypto.createHmac('sha256', API_KEY).update(payloadStr, 'utf8').digest('hex');
}

export function aesEncrypt(buf: Buffer, key: Buffer = AES_KEY, iv: Buffer = AES_IV): Buffer {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([cipher.update(buf), cipher.final()]);
}

export function aesDecrypt(buf: Buffer, key: Buffer = AES_KEY, iv: Buffer = AES_IV): Buffer | null {
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([decipher.update(buf), decipher.final()]);
  } catch {
    return null;
  }
}

export function encodeVarint(input: number | bigint): Buffer {
  let n = typeof input === 'bigint' ? input : BigInt(Math.trunc(input));
  if (n < 0n) {
    n = BigInt.asUintN(64, n);
  }
  const out: number[] = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    out.push(b);
  } while (n > 0n);
  return Buffer.from(out);
}

export function decodeVarint(data: Buffer, offset: number): [bigint | null, number] {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < data.length) {
    const byte = data[pos];
    result |= BigInt(byte & 0x7f) << shift;
    pos += 1;
    if ((byte & 0x80) === 0) {
      return [result, pos];
    }
    shift += 7n;
    if (shift > 70n) break;
  }
  return [null, pos];
}

export type ProtoValue =
  | number
  | bigint
  | boolean
  | string
  | Buffer
  | ProtoFields
  | ProtoValue[];

export interface ProtoFields {
  [field: string]: ProtoValue;
}

function pbVarint(fn: number, val: number | bigint): Buffer {
  return Buffer.concat([encodeVarint((BigInt(fn) << 3n) | 0n), encodeVarint(val)]);
}

function pbLength(fn: number, val: string | Buffer): Buffer {
  const enc = typeof val === 'string' ? Buffer.from(val, 'utf8') : val;
  return Buffer.concat([
    encodeVarint((BigInt(fn) << 3n) | 2n),
    encodeVarint(enc.length),
    enc,
  ]);
}

export function createProto(fields: ProtoFields): Buffer {
  const chunks: Buffer[] = [];
  for (const [rawField, value] of Object.entries(fields)) {
    const field = Number(rawField);
    if (!Number.isFinite(field)) continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        if (Buffer.isBuffer(item)) chunks.push(pbLength(field, item));
        else if (typeof item === 'string') chunks.push(pbLength(field, item));
        else if (typeof item === 'boolean') chunks.push(pbVarint(field, item ? 1 : 0));
        else if (typeof item === 'number' || typeof item === 'bigint') chunks.push(pbVarint(field, item));
        else if (item && typeof item === 'object') chunks.push(pbLength(field, createProto(item as ProtoFields)));
      }
    } else if (Buffer.isBuffer(value)) {
      chunks.push(pbLength(field, value));
    } else if (typeof value === 'string') {
      chunks.push(pbLength(field, value));
    } else if (typeof value === 'boolean') {
      chunks.push(pbVarint(field, value ? 1 : 0));
    } else if (typeof value === 'number' || typeof value === 'bigint') {
      chunks.push(pbVarint(field, value));
    } else if (value && typeof value === 'object') {
      chunks.push(pbLength(field, createProto(value as ProtoFields)));
    }
  }
  return Buffer.concat(chunks);
}

export function encodeProtoStd(fields: ProtoFields): Buffer {
  const keys = Object.keys(fields)
    .map((k) => Number(k))
    .filter((k) => Number.isFinite(k))
    .sort((a, b) => a - b);
  const chunks: Buffer[] = [];
  for (const f of keys) {
    const v = fields[f];
    if (typeof v === 'boolean') chunks.push(pbVarint(f, v ? 1 : 0));
    else if (typeof v === 'number' || typeof v === 'bigint') chunks.push(pbVarint(f, v));
    else if (typeof v === 'string' || Buffer.isBuffer(v)) chunks.push(pbLength(f, v));
  }
  return Buffer.concat(chunks);
}

export function extractRawFields(data: Buffer): Record<number, bigint | Buffer> {
  const result: Record<number, bigint | Buffer> = {};
  let offset = 0;
  while (offset < data.length) {
    const [header, nextOffset] = decodeVarint(data, offset);
    offset = nextOffset;
    if (header === null) break;
    const fn = Number(header >> 3n);
    const wt = Number(header & 0x7n);
    if (wt === 0) {
      const [v, o2] = decodeVarint(data, offset);
      offset = o2;
      if (v !== null) result[fn] = v;
    } else if (wt === 2) {
      const [lenBig, o2] = decodeVarint(data, offset);
      offset = o2;
      if (lenBig === null) break;
      const len = Number(lenBig);
      if (len < 0 || offset + len > data.length) break;
      result[fn] = data.subarray(offset, offset + len);
      offset += len;
    } else if (wt === 1) {
      offset += 8;
    } else if (wt === 5 || wt === 3) {
      offset += 4;
    } else {
      break;
    }
  }
  return result;
}

export type DecodedValue = number | string | DecodedDict;
export interface DecodedDict {
  [field: number]: DecodedValue;
}

function isProbablyUtf8Text(buf: Buffer): string | null {
  if (buf.length === 0) return null;
  const s = buf.toString('utf8');
  if (s.includes('\ufffd')) return null;
  // Reject control characters except whitespace
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return null;
  }
  return s;
}

export function decodeProtobuf2(data: Buffer, depth = 0): DecodedDict {
  const result: DecodedDict = {};
  if (depth > 8) return result;
  let offset = 0;
  while (offset < data.length) {
    const [header, o1] = decodeVarint(data, offset);
    offset = o1;
    if (header === null) break;
    const fn = Number(header >> 3n);
    const wt = Number(header & 0x7n);
    if (fn <= 0 || fn > 2000) break;

    if (wt === 0) {
      const [v, o2] = decodeVarint(data, offset);
      offset = o2;
      if (v === null) break;
      result[fn] = v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
    } else if (wt === 2) {
      const [lenBig, o2] = decodeVarint(data, offset);
      offset = o2;
      if (lenBig === null) break;
      const len = Number(lenBig);
      if (len < 0 || offset + len > data.length) break;
      const slice = data.subarray(offset, offset + len);
      offset += len;
      const str = isProbablyUtf8Text(slice);
      if (str !== null) {
        result[fn] = str;
      } else {
        const nested = decodeProtobuf2(slice, depth + 1);
        result[fn] = Object.keys(nested).length > 0 ? nested : slice.toString('hex');
      }
    } else if (wt === 1) {
      if (offset + 8 > data.length) break;
      offset += 8;
    } else if (wt === 5 || wt === 3) {
      if (offset + 4 > data.length) break;
      offset += 4;
    } else {
      break;
    }
  }
  return result;
}

export function createPacket(pkHex: string, prefixHex: string, key: Buffer, iv: Buffer): Buffer {
  const encHex = aesEncrypt(Buffer.from(pkHex, 'hex'), key, iv).toString('hex');
  const len = encHex.length / 2;
  let hexLen = len.toString(16);
  if (hexLen.length % 2 !== 0) hexLen = '0' + hexLen;
  const padCount = Math.max(0, 12 - prefixHex.length - hexLen.length);
  return Buffer.from(prefixHex + '0'.repeat(padCount) + hexLen + encHex, 'hex');
}

export function crc7Buff(crc: number, buf: Buffer): number {
  let c = crc & 0x7f;
  for (const b of buf) {
    c = CRC7_TABLE[((2 * (c & 0xff)) ^ (b & 0xff)) & 0xff] & 0x7f;
  }
  return c & 0x7f;
}

/**
 * Recursively extracts ALL varint integers and UTF-8 strings from a protobuf buffer
 * WITHOUT overwriting repeated fields (unlike plain map decoding).
 * Critically needed for parsing team member lists inside 0500 responses.
 */
export function extractProtoPrimitives(
  data: Buffer,
  depth = 0,
  out?: { numbers: Set<string>; strings: Set<string> },
): { numbers: Set<string>; strings: Set<string> } {
  const acc = out || { numbers: new Set<string>(), strings: new Set<string>() };
  if (depth > 8 || !data || data.length === 0) return acc;

  let offset = 0;
  while (offset < data.length) {
    const [header, o1] = decodeVarint(data, offset);
    if (header === null || o1 <= offset) break;
    offset = o1;
    const fn = Number(header >> 3n);
    const wt = Number(header & 0x7n);
    if (fn <= 0 || fn > 4000) break;

    if (wt === 0) {
      const [v, o2] = decodeVarint(data, offset);
      if (v === null || o2 <= offset) break;
      offset = o2;
      acc.numbers.add(v.toString());
    } else if (wt === 2) {
      const [lenBig, o2] = decodeVarint(data, offset);
      if (lenBig === null || o2 <= offset) break;
      offset = o2;
      const len = Number(lenBig);
      if (len < 0 || offset + len > data.length) break;
      const slice = data.subarray(offset, offset + len);
      offset += len;

      const text = isProbablyUtf8Text(slice);
      if (text !== null && text.length > 0) {
        acc.strings.add(text);
        if (/^\d{5,18}$/.test(text)) acc.numbers.add(text);
      }
      if (slice.length >= 2) {
        extractProtoPrimitives(slice, depth + 1, acc);
      }
    } else if (wt === 1) {
      if (offset + 8 > data.length) break;
      offset += 8;
    } else if (wt === 5 || wt === 3) {
      if (offset + 4 > data.length) break;
      offset += 4;
    } else {
      break;
    }
  }
  return acc;
}

