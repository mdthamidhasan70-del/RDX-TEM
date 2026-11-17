import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import { crc7Buff, encodeVarint } from './proto.ts';

const DELTA = 0x9e3779b9;
const ROUNDS = 16;
const FIELD_SIZES: Record<number, number> = { 0: 1, 1: 2, 2: 2, 3: 1, 4: 2 };
const FIELD_NAMES: Record<number, 'sendOption' | 'cmd' | 'orderId' | 'flags' | 'length'> = {
  0: 'sendOption',
  1: 'cmd',
  2: 'orderId',
  3: 'flags',
  4: 'length',
};

const CS_OVERSEA_BLOCK = Buffer.from(
  'ca0163736f7665727365612e7374726f6e67686f6c642e66726565666972656d6f62696c652e636f6d' +
    '3b302e302e302e303b33342e3132362e37362e34353b33342e38372e3137372e31343b33342e38372e' +
    '3137302e3233303b33352e3138352e3138332e35370000000000000100000000000000000000000001' +
    '00000800000100000000000100a8a2d7bebd8d8bdf110200',
  'hex',
);

const MOVE_TAIL = Buffer.concat([
  Buffer.alloc(7, 0),
  Buffer.from([0x93, 0xca, 0xd5, 0xf9, 0x0b, 0x8e, 0xfe, 0xfc, 0xf7, 0x0b, 0xf4, 0xe0, 0xfe, 0xf7, 0x03, 0x00, 0x00]),
]);

const DNS_CACHE = new Map<string, { ip: string; exp: number }>();

async function resolveIpv4(hostname: string): Promise<string> {
  if (!hostname) return hostname;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return hostname;
  const cached = DNS_CACHE.get(hostname);
  if (cached && Date.now() < cached.exp) return cached.ip;
  try {
    const res = await dns.lookup(hostname, { family: 4 });
    if (res.address) {
      DNS_CACHE.set(hostname, { ip: res.address, exp: Date.now() + 300_000 });
      return res.address;
    }
  } catch {
    // fallback to hostname
  }
  return hostname;
}

function hasSsanZig(n: number): Buffer {
  const z = (BigInt(Math.trunc(n)) << 1n) & 0xffffffffffffffffn;
  return encodeVarint(z);
}

function zigzagEncodeSigned(n: number): Buffer {
  const bn = BigInt(Math.trunc(n));
  const zz = bn >= 0n ? bn << 1n : ((-bn) << 1n) - 1n;
  return encodeVarint(zz & 0xffffffffffffffffn);
}

function teaEnc(v0In: number, v1In: number, k0: number, k1: number, k2: number, k3: number): [number, number] {
  let v0 = v0In >>> 0;
  let v1 = v1In >>> 0;
  let s = 0;
  for (let i = 0; i < ROUNDS; i++) {
    s = (s + DELTA) >>> 0;
    const a = (((v1 << 4) >>> 0) + k0) >>> 0;
    const b = (v1 + s) >>> 0;
    const c = ((v1 >>> 5) + k1) >>> 0;
    v0 = (v0 + ((a ^ b ^ c) >>> 0)) >>> 0;

    const d = (((v0 << 4) >>> 0) + k2) >>> 0;
    const e = (v0 + s) >>> 0;
    const f = ((v0 >>> 5) + k3) >>> 0;
    v1 = (v1 + ((d ^ e ^ f) >>> 0)) >>> 0;
  }
  return [v0, v1];
}

function teaDec(v0In: number, v1In: number, k0: number, k1: number, k2: number, k3: number): [number, number] {
  let v0 = v0In >>> 0;
  let v1 = v1In >>> 0;
  let s = Math.imul(DELTA, ROUNDS) >>> 0;
  for (let i = 0; i < ROUNDS; i++) {
    const d = (((v0 << 4) >>> 0) + k2) >>> 0;
    const e = (v0 + s) >>> 0;
    const f = ((v0 >>> 5) + k3) >>> 0;
    v1 = (v1 - ((d ^ e ^ f) >>> 0)) >>> 0;

    const a = (((v1 << 4) >>> 0) + k0) >>> 0;
    const b = (v1 + s) >>> 0;
    const c = ((v1 >>> 5) + k1) >>> 0;
    v0 = (v0 - ((a ^ b ^ c) >>> 0)) >>> 0;

    s = (s - DELTA) >>> 0;
  }
  return [v0, v1];
}

function teaCbcEncrypt(padded: Buffer, keyBytes: Buffer): Buffer {
  const k0 = keyBytes.readUInt32LE(0);
  const k1 = keyBytes.readUInt32LE(4);
  const k2 = keyBytes.readUInt32LE(8);
  const k3 = keyBytes.readUInt32LE(12);
  const out = Buffer.alloc(padded.length);
  const pc = Buffer.alloc(8);
  const pi = Buffer.alloc(8);
  const x = Buffer.alloc(8);
  const enc = Buffer.alloc(8);

  for (let i = 0; i < padded.length; i += 8) {
    for (let j = 0; j < 8; j++) x[j] = padded[i + j] ^ pc[j];
    const [e0, e1] = teaEnc(x.readUInt32LE(0), x.readUInt32LE(4), k0, k1, k2, k3);
    enc.writeUInt32LE(e0, 0);
    enc.writeUInt32LE(e1, 4);
    for (let j = 0; j < 8; j++) out[i + j] = enc[j] ^ pi[j];
    out.copy(pc, 0, i, i + 8);
    x.copy(pi, 0, 0, 8);
  }
  return out;
}

function teaCbcDecrypt(body: Buffer, keyBytes: Buffer): Buffer {
  const k0 = keyBytes.readUInt32LE(0);
  const k1 = keyBytes.readUInt32LE(4);
  const k2 = keyBytes.readUInt32LE(8);
  const k3 = keyBytes.readUInt32LE(12);
  const out = Buffer.alloc(body.length);
  const pi = Buffer.alloc(8);
  const pc = Buffer.alloc(8);
  const x = Buffer.alloc(8);
  const dec = Buffer.alloc(8);

  for (let i = 0; i < body.length; i += 8) {
    for (let j = 0; j < 8; j++) x[j] = body[i + j] ^ pi[j];
    const [d0, d1] = teaDec(x.readUInt32LE(0), x.readUInt32LE(4), k0, k1, k2, k3);
    dec.writeUInt32LE(d0, 0);
    dec.writeUInt32LE(d1, 4);
    for (let j = 0; j < 8; j++) out[i + j] = dec[j] ^ pc[j];
    body.copy(pc, 0, i, i + 8);
    dec.copy(pi, 0, 0, 8);
  }
  return out;
}

function buildPadded(content: Buffer): Buffer {
  const padLen = (8 - ((content.length + 10) % 8)) % 8;
  return Buffer.concat([Buffer.from([padLen, 0, 0]), Buffer.alloc(padLen, 0), content, Buffer.alloc(7, 0)]);
}

function oicqUnpad(padded: Buffer): Buffer | null {
  if (!padded || padded.length < 8) return null;
  for (let i = 0; i < 7; i++) {
    if (padded[padded.length - 1 - i] !== 0) return null;
  }
  const padLen = padded[0] & 0x07;
  const s = 3 + padLen;
  const e = padded.length - 7;
  return s < e ? padded.subarray(s, e) : Buffer.alloc(0);
}

function layoutsFromMask(mask: string): { ru: number[]; nr: number[] } {
  const ru = mask
    .trim()
    .split('')
    .map((c) => Number(c))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 4);
  const nr = ru.filter((c) => c !== 2);
  return { ru, nr };
}

function encodeHeader(
  layout: number[],
  so: number,
  cmd: number,
  oid: number | null,
  flags: number,
  length: number,
  k: number,
  v80: number,
): Buffer {
  const bytes: number[] = [];
  for (const code of layout) {
    const val = code === 0 ? so : code === 1 ? cmd : code === 2 ? oid ?? 0 : code === 3 ? flags : length;
    if (FIELD_SIZES[code] === 1) {
      bytes.push((val & 0xff) ^ k);
    } else {
      const v = ((val & 0xffff) ^ v80) & 0xffff;
      bytes.push(v & 0xff, (v >> 8) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function buildPacket(
  msgKey: number,
  layout: number[],
  so: number,
  cmd: number,
  oid: number | null,
  flags: number,
  content: Buffer,
  key: Buffer,
  encrypted = true,
): Buffer {
  const k = key[0];
  const v80 = ((k << 8) | k) & 0xffff;
  const body = encrypted ? teaCbcEncrypt(buildPadded(content), key) : content;
  const hdr = Buffer.concat([Buffer.from([msgKey & 0xff, 0]), encodeHeader(layout, so, cmd, oid, flags, body.length, k, v80)]);
  const pkt = Buffer.concat([hdr, body]);
  pkt[1] = crc7Buff(0, pkt.subarray(2)) & 0x7f;
  return pkt;
}

interface DecodedUdpFrame {
  kind: 'RUDP' | 'nonRUDP';
  msgKey: number;
  cmd: number;
  flags: number;
  sendOption: number;
  orderId?: number;
  content: Buffer;
}

function tryHeader(
  buf: Buffer,
  layout: number[],
  k: number,
  v80: number,
): { sendOption: number; cmd: number; orderId?: number; flags: number; length: number; headerLen: number } | null {
  let off = 2;
  const out: Record<string, number> = {};
  for (const code of layout) {
    const size = FIELD_SIZES[code];
    if (off + size > buf.length) return null;
    const name = FIELD_NAMES[code];
    if (size === 1) {
      out[name] = buf[off] ^ k;
    } else {
      out[name] = ((buf[off] | (buf[off + 1] << 8)) ^ v80) & 0xffff;
    }
    off += size;
  }
  return {
    sendOption: out.sendOption ?? 0,
    cmd: out.cmd ?? 0,
    orderId: out.orderId,
    flags: out.flags ?? 0,
    length: out.length ?? 0,
    headerLen: off,
  };
}

function decodeUdpPacket(data: Buffer, key: Buffer, mask: string): DecodedUdpFrame | null {
  if (data.length < 8) return null;
  const k = key[0];
  const v80 = ((k << 8) | k) & 0xffff;
  const crcOk = (data[1] & 0x7f) === crc7Buff(0, data.subarray(2));
  const { ru, nr } = layoutsFromMask(mask);
  const candidates: Array<DecodedUdpFrame & { score: number }> = [];

  const layouts: Array<{ kind: 'RUDP' | 'nonRUDP'; layout: number[] }> = [
    { kind: 'RUDP', layout: ru },
    { kind: 'nonRUDP', layout: nr },
  ];

  for (const { kind, layout } of layouts) {
    if (layout.length === 0) continue;
    const f = tryHeader(data, layout, k, v80);
    if (!f) continue;
    if (f.flags > 7 || f.sendOption > 7) continue;
    if (f.length !== data.length - f.headerLen) continue;
    const body = data.subarray(f.headerLen, f.headerLen + f.length);
    let content: Buffer | null = null;
    if (f.flags & 1) {
      if (body.length < 8 || body.length % 8 !== 0) continue;
      content = oicqUnpad(teaCbcDecrypt(body, key));
      if (content === null) continue;
    } else {
      content = body;
    }
    const score = (crcOk ? 1 : 0) + (content !== null ? 1 : 0);
    candidates.push({
      kind,
      msgKey: data[0],
      cmd: f.cmd,
      flags: f.flags,
      sendOption: f.sendOption,
      orderId: f.orderId,
      content,
      score,
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

function buildHelloPacket(text: string, key: Buffer, mask: string): Buffer {
  const data = Buffer.from(text, 'utf8');
  const padZeroLen = Math.max(0, 29 - 4 - data.length);
  const content = Buffer.concat([Buffer.from([0x10, 0x00, 0x00, 0x00]), data, Buffer.alloc(padZeroLen, 0)]);
  const { ru } = layoutsFromMask(mask);
  return buildPacket(0x63, ru, 1, 1, 0, 1, content, key, true);
}

function buildMatchStartupPackets(opts: {
  token: string;
  udpKey: Buffer;
  matchCode: string;
  accountId: string;
  blockVal: number;
  serverIpPort: string;
  region: string;
  clientVersion: string;
  accessToken: string;
  modeId?: number;
  mapId?: number;
}): { thunder: Buffer; sharma: Buffer } {
  const tok = opts.token.trim();
  const thunderJwt = tok.length > 660 ? tok.slice(0, 660) : tok;
  const sharmaJwt = tok.length > 660 ? tok.slice(660) : '';
  const eth = Buffer.from(thunderJwt, 'utf8');
  const esh = Buffer.from(sharmaJwt, 'utf8');
  const reg = (opts.region || 'BD').toUpperCase();
  const cv = opts.clientVersion || '1.132.9';
  const cvCode = '2019121229';
  const cleanIp = opts.serverIpPort.split(':')[0] || '0.0.0.0';
  const cleanAccTok = (opts.accessToken || '').trim();

  const garena420 = Buffer.concat([hasSsanZig(eth.length), eth]);
  const midParts: Buffer[] = [
    Buffer.from('0000000001000102030101', 'hex'),
    hasSsanZig(reg.length),
    Buffer.from(reg, 'utf8'),
    Buffer.from('0001030003000004', 'hex'),
    hasSsanZig(cv.length),
    Buffer.from(cv, 'utf8'),
    hasSsanZig(cvCode.length),
    Buffer.from(cvCode, 'utf8'),
    CS_OVERSEA_BLOCK,
    hasSsanZig(cleanIp.length),
    Buffer.from(cleanIp, 'utf8'),
  ];
  if (cleanAccTok) {
    midParts.push(hasSsanZig(cleanAccTok.length), Buffer.from(cleanAccTok, 'utf8'));
  }
  midParts.push(hasSsanZig(esh.length), esh);
  const mid = Buffer.concat(midParts);

  const accBig = BigInt(opts.accountId || '0');
  const blkBig = BigInt(opts.blockVal || 0);
  const modeBig = BigInt(opts.modeId || 1);
  const mapBig = BigInt(opts.mapId || 1);
  const tg = Buffer.concat([
    encodeVarint(accBig),
    encodeVarint(blkBig),
    encodeVarint(1),
    encodeVarint(modeBig),
    encodeVarint(blkBig),
    encodeVarint(mapBig),
    mid,
  ]);

  const { ru } = layoutsFromMask(opts.matchCode);
  return {
    thunder: buildPacket(0x5e, ru, 2, 447, 0, 1, garena420, opts.udpKey, true),
    sharma: buildPacket(0x5a, ru, 2, 448, 1, 1, tg, opts.udpKey, true),
  };
}

function buildMovementPacket2001(
  keyBytes: Buffer,
  playerState: number,
  x: number,
  y: number,
  z: number,
  tick: number,
  counter: number,
  moveState: number,
  accountUid: string,
): Buffer {
  const body = Buffer.concat([
    encodeVarint(BigInt(accountUid || '0')),
    encodeVarint(playerState),
    zigzagEncodeSigned(Math.trunc(x)),
    zigzagEncodeSigned(Math.trunc(y)),
    zigzagEncodeSigned(Math.trunc(z)),
    Buffer.from([0]),
    encodeVarint(moveState),
    MOVE_TAIL,
    encodeVarint(tick),
    Buffer.from([0, 0, 0]),
    encodeVarint(counter),
  ]);
  const k = keyBytes[0];
  const v80 = ((k << 8) | k) & 0xffff;
  const h = Buffer.alloc(8);
  h[0] = 0x6b;
  h[1] = 0x00;
  h[2] = 0x00 ^ k;
  h.writeUInt16LE((2001 ^ v80) & 0xffff, 3);
  h.writeUInt16LE((body.length ^ v80) & 0xffff, 5);
  h[7] = 0x00 ^ k;
  const full = Buffer.concat([h, body]);
  full[1] = crc7Buff(0, full.subarray(2)) & 0x7f;
  return full;
}

export interface UdpMatchHandle {
  stop: () => void;
}

export type UdpMatchFinishReason = 'completed' | 'interrupted' | 'expired';

export function startUdpMatchSession(params: {
  serverIpPort: string;
  token: string;
  udpKeyHex: string;
  matchCode: string;
  accountId: string;
  blockVal: number;
  region: string;
  clientVersion: string;
  accessToken: string;
  modeId?: number;
  mapId?: number;
  maxDurationMs?: number;
  isStopped: () => boolean;
  onPlaying: () => void;
  onLog: (msg: string, level: 'info' | 'success' | 'warning' | 'error') => void;
  onFinished: (reason: UdpMatchFinishReason) => void;
}): UdpMatchHandle {
  let closed = false;
  let ackState: 'waiting_for_hello' | 'ack_sent_waiting' | 'ready_to_send_thunder' | 'playing' = 'waiting_for_hello';
  let thunderSent = false;
  let joinMatchReceived = false;
  const startedAt = Date.now();
  let lastActivity = Date.now();

  const udpKey = Buffer.from(params.udpKeyHex, 'hex');
  const { nr } = layoutsFromMask(params.matchCode);
  const { thunder, sharma } = buildMatchStartupPackets({
    token: params.token,
    udpKey,
    matchCode: params.matchCode,
    accountId: params.accountId,
    blockVal: params.blockVal,
    serverIpPort: params.serverIpPort,
    region: params.region,
    clientVersion: params.clientVersion,
    accessToken: params.accessToken,
    modeId: params.modeId,
    mapId: params.mapId,
  });

  const sock = dgram.createSocket('udp4');
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let watchTimer: ReturnType<typeof setInterval> | null = null;
  let moveTimer: ReturnType<typeof setInterval> | null = null;
  let targetIp = '';
  let targetPort = 0;

  let angle = Math.random() * Math.PI * 2;
  let px = 0;
  let py = 0;
  let pz = 0;
  let tick = 0;
  let counter = 0;
  let pingIdx = 0;
  const pingKeys = [0x66, 0x6d, 0x69, 0x6c, 0x6b, 0x6e, 0x6f, 0x70];

  const cleanup = (reason: UdpMatchFinishReason = 'interrupted') => {
    if (closed) return;
    closed = true;
    if (pingTimer) clearInterval(pingTimer);
    if (watchTimer) clearInterval(watchTimer);
    if (moveTimer) clearInterval(moveTimer);
    try {
      sock.close();
    } catch {
      // ignore
    }
    params.onFinished(reason);
  };

  const sendRaw = (buf: Buffer) => {
    if (closed || !targetIp || !targetPort) return;
    try {
      sock.send(buf, targetPort, targetIp);
    } catch {
      // ignore
    }
  };

  const sendThunderSharma = () => {
    if (thunderSent || closed) return;
    thunderSent = true;
    ackState = 'playing';
    sendRaw(thunder);
    setTimeout(() => {
      if (closed) return;
      sendRaw(buildPacket(0x68, nr, 0, 2, null, 1, Buffer.from([0x01, 0x00]), udpKey, true));
    }, 300);
    setTimeout(() => {
      if (closed) return;
      sendRaw(sharma);
      params.onPlaying();
      moveTimer = setInterval(() => {
        if (closed || params.isStopped()) return;
        angle += (Math.PI * 2) / 18;
        px = Math.max(-160, Math.min(160, px + Math.cos(angle) * 14));
        py = Math.max(-160, Math.min(160, py + Math.sin(angle) * 14));
        pz = Math.max(-25, Math.min(25, pz + (Math.random() - 0.5) * 0.4));
        tick = (tick + 1) & 0xffff;
        counter = (counter + 1) & 0xffff;
        sendRaw(buildMovementPacket2001(udpKey, 1, px, py, pz, tick, counter, 2, params.accountId));
      }, 320);
    }, 700);
  };

  sock.on('error', (err) => {
    params.onLog(`Match UDP socket error (${params.accountId}): ${err.message}`, 'warning');
    cleanup('interrupted');
  });

  sock.on('message', (msg) => {
    lastActivity = Date.now();
    const frame = decodeUdpPacket(msg, udpKey, params.matchCode);
    if (!frame) return;

    if (frame.cmd === 103 || frame.cmd === 107) {
      cleanup('completed');
      return;
    }

    if (frame.cmd === 101) {
      sendRaw(buildPacket(0x68, nr, 0, 2, null, 1, Buffer.from([0x01, 0x00]), udpKey, true));
      return;
    }

    if (frame.cmd === 1) {
      // UDP_HELLO
      sendRaw(buildPacket(0x68, nr, 0, 2, null, 1, Buffer.from([0x01, 0x00]), udpKey, true));
      if (ackState === 'waiting_for_hello') {
        ackState = 'ack_sent_waiting';
      }
      return;
    }

    if (frame.cmd === 2) {
      // UDP_ACK
      if (ackState === 'waiting_for_hello') {
        sendRaw(buildPacket(0x68, nr, 0, 2, null, 1, frame.content.length ? frame.content : Buffer.from([0x01, 0x00]), udpKey, true));
        ackState = 'ready_to_send_thunder';
        sendThunderSharma();
      } else if (ackState === 'ack_sent_waiting') {
        ackState = 'ready_to_send_thunder';
        sendThunderSharma();
      } else {
        sendRaw(buildPacket(0x68, nr, 0, 2, null, 1, frame.content.length ? frame.content : Buffer.from([0x01, 0x00]), udpKey, true));
      }
      return;
    }

    if (frame.cmd === 3) {
      // UDP_PING
      const c4 = frame.content.length >= 4 ? frame.content.subarray(0, 4) : frame.content;
      sendRaw(buildPacket(0x6d, nr, 0, 3, null, 0, Buffer.concat([c4, Buffer.from([0, 0, 0])]), udpKey, false));
      return;
    }

    if (!joinMatchReceived && frame.cmd > 3 && frame.sendOption === 2) {
      sendRaw(buildPacket(0x68, nr, 0, 2, null, 1, Buffer.from([0x02, 0x00]), udpKey, true));
      joinMatchReceived = true;
    }
  });

  (async () => {
    const [host, portStr] = params.serverIpPort.split(':');
    targetPort = Number(portStr || 0);
    targetIp = await resolveIpv4(host);
    if (!targetIp || !targetPort || closed || params.isStopped()) {
      cleanup('interrupted');
      return;
    }

    const helloPkt = buildHelloPacket(`${params.accountId}_2585`, udpKey, params.matchCode);
    sendRaw(helloPkt);

    pingTimer = setInterval(() => {
      if (closed || params.isStopped()) return;
      const pk = pingKeys[pingIdx % pingKeys.length];
      pingIdx += 1;
      const c = Buffer.alloc(7);
      c.writeUInt32LE(Date.now() >>> 0, 0);
      sendRaw(buildPacket(pk, nr, 0, 3, null, 0, c, udpKey, false));
    }, 3000);

    watchTimer = setInterval(() => {
      if (closed) return;
      if (params.isStopped()) {
        cleanup();
        return;
      }
      const now = Date.now();
      const maxDurationMs = params.maxDurationMs ?? 45 * 60_000;
      if (now - startedAt > maxDurationMs) {
        params.onLog(
          `Match session safety timeout (${params.accountId}, ${Math.round(maxDurationMs / 1000)}s)`,
          'warning',
        );
        cleanup('expired');
        return;
      }
      if (ackState === 'waiting_for_hello') {
        if (now - lastActivity > 6500) {
          sendRaw(helloPkt);
          lastActivity = now;
        }
        if (now - startedAt > 25_000) {
          params.onLog(`Match UDP handshake timeout (${params.accountId})`, 'warning');
          cleanup('interrupted');
        }
      } else if (ackState === 'playing' && now - lastActivity > 120_000) {
        params.onLog(`Match UDP session inactive (${params.accountId}); preserving match state`, 'warning');
        cleanup('interrupted');
      }
    }, 2000);
  })();

  return {
    stop: () => cleanup('interrupted'),
  };
}
