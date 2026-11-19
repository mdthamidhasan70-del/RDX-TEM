import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import {
  AES_IV,
  AES_KEY,
  GGRE_RAW,
  HEX_KEY,
  KEYSTREAM,
  aesDecrypt,
  aesEncrypt,
  createPacket,
  createProto,
  decodeProtobuf2,
  encodeProtoStd,
  extractProtoPrimitives,
  extractRawFields,
  generateSignature,
  type DecodedDict,
} from './proto.ts';
import { startUdpMatchSession, type UdpMatchHandle } from './udp.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const LOST_ACCOUNTS_FILE = path.join(DATA_DIR, 'lost_accounts.json');
const GUILDS_FILE = path.join(DATA_DIR, 'guilds.json');
const SQUADS_FILE = path.join(DATA_DIR, 'squads.json');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const TOKEN_CACHE_FILE = path.join(DATA_DIR, 'token_cache.json');

const TOKEN_CACHE_TTL_MS = 1200 * 1000;
const MATCHMAKING_REJECTION_BACKOFF_MS = 30_000;
const MATCH_CANCEL_RETRY_DELAY_MS = 500;
const MATCH_CYCLE_RESET_AFTER = 10;
const MAX_SQUAD_SIZE = 4;
export const CLAN_ID_DEFAULT = '3106921760';

const SEED_ACCOUNTS: SavedAccountRow[] = [];

export type GameModeId = 'BR_RANK' | 'CS_RANK';

export interface SavedAccountRow {
  uid: string;
  password: string;
  region: string;
  clan_id: string;
  squad_id?: string;
  bot_prefix?: string;
  nickname?: string;
  max_matches?: number;
  max_hours?: number;
  replacement_pending_match?: boolean;
}

interface ArchivedAccountRow extends SavedAccountRow {
  removed_at: number;
  removal_reason: string;
}

export interface RecoveryAccountInfo {
  uid: string;
  nickname?: string;
  region: string;
  clan_id: string;
  squad_id?: string;
  status: string;
  removed_at?: number;
  removal_reason?: string;
}

export interface GuildConfig {
  clan_id: string;
  name: string;
  region: string;
  verified: boolean;
  created_at: number;
  duration_days: number;
  duration_hours: number;
  duration_minutes: number;
  expires_at: number | null;
  is_paused: boolean;
}

export interface SquadConfig {
  id: string;
  clan_id: string;
  name: string;
  target_size: number;
  completed_matches_in_cycle?: number;
  game_mode?: GameModeId;
  lobby_delay_sec?: number;
  bot_prefix?: string;
  is_paused: boolean;
  created_at: number;
}

export interface EngineLogEntry {
  t: number;
  time: string;
  message: string;
  level: 'info' | 'success' | 'warning' | 'error';
}

export interface EngineAccountState {
  uid: string;
  auth_uid?: string;
  nickname: string;
  region: string;
  level: number;
  exp: number;
  current_exp: number;
  initial_exp: number;
  gained_exp: number;
  likes: number;
  status: string;
  is_paused: boolean;
  matches: number;
  matches_played: number;
  active_matches: number;
  uptime_seconds: number;
  squad_id?: string | null;
  squad_name?: string | null;
  clan_id?: string;
  clan_name?: string;
  guild_joined?: boolean;
  in_squad?: boolean;
  is_leader?: boolean;
  team_code?: string | null;
  max_matches?: number;
  max_hours?: number;
  last_match_time?: string;
  start_time: number;
  paused_at: number | null;
  total_pause_duration: number;
}

interface AccountCredentials {
  account_id: string;
  nickname: string;
  region: string;
  level: number;
  exp: number;
  likes: number;
  open_id: string;
  access_token: string;
  platform: string;
  token: string;
  server_time: number;
  aes_ak: Buffer;
  iv_i: Buffer;
  functional_addrs: string;
  informational_addrs: string;
  release_version: string;
  client_version: string;
  server_url: string;
  login_payload_data: Buffer;
  auth_type: 'guest' | 'token';
  auth_uid?: string;
  auth_password?: string;
  auth_token?: string;
  clan_id?: string;
  squad_id?: string;
  max_matches?: number;
  max_hours?: number;
}

interface WorkerControl {
  cancelled: boolean;
  fastReconnect?: boolean;
  loginFailureCount?: number;
  sockets: Set<net.Socket>;
  timers: Set<ReturnType<typeof setTimeout>>;
  udpHandles: Set<UdpMatchHandle>;
  mainClosed: boolean;
}

interface PeerEntry {
  uid: string;
  squadKey: string;
  socket: net.Socket;
  cred: AccountCredentials;
  ctrl: WorkerControl;
  guildJoined: boolean;
  inSquad: boolean;
  readyAt: number;
  inviteAcceptedAt: number;
  lastInviteReceivedAt: number;
}

interface SquadRuntime {
  squadKey: string;
  clanId: string;
  peers: Map<string, PeerEntry>;
  leaderUid: string | null;
  teamCode: string | null;
  teamGroupId: string | null;
  teamCreated: boolean;
  matchSearching: boolean;
  searchStartedAt: number;
  searchRetries: number;
  matchStartedAt: number;
  lastMatchEndedAt: number;
  coordinatorRunning: boolean;
  startingMatchLock: boolean;
  lastFreshRequestedAt: number;
  lastRecoveryAt: number;
  modeProfileIdx: number;
  modeRevision: number;
  loopTimer: ReturnType<typeof setInterval> | null;
}

interface CreationJob {
  clanId: string;
  chunkSizes: number[];
  squadIds: string[];
  password: string;
  botPrefix: string;
}

export function normalizeGameMode(raw?: string): GameModeId {
  const s = String(raw ?? 'BR_RANK').trim().toUpperCase().replace(/[\s-]+/g, '_');
  const clashVariants = new Set(['CS', 'CS_RANK', 'CS_RANKED', 'CLASH_SQUAD', 'CLASH_SQUAD_RANK', 'CLASH_SQUAD_RANKED']);
  const battleVariants = new Set(['BR', 'BR_RANK', 'BR_RANKED', 'BATTLE_ROYALE', 'BATTLE_ROYALE_RANK', 'BATTLE_ROYALE_RANKED']);
  if (clashVariants.has(s)) return 'CS_RANK';
  if (battleVariants.has(s)) return 'BR_RANK';
  return 'BR_RANK';
}

export function sanitizeFiniteNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : fallback;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function getReconnectDelayMs(failureCount: number): number {
  const failures = Math.max(1, Math.floor(Number(failureCount) || 1));
  return Math.min(5 * 60_000, 5_000 * 2 ** (failures - 1));
}

export function getSquadAvailableSlots(memberCount: number, pendingCount = 0): number {
  const members = Math.max(0, Math.floor(Number(memberCount) || 0));
  const pending = Math.max(0, Math.floor(Number(pendingCount) || 0));
  return Math.max(0, MAX_SQUAD_SIZE - members - pending);
}

export function getEffectiveSquadSize(configuredSize: number, assignedMembers: number, pendingCount = 0): number {
  const assigned = Math.max(0, Math.floor(Number(assignedMembers) || 0));
  const pending = Math.max(0, Math.floor(Number(pendingCount) || 0));
  const configured = Math.max(2, Math.min(MAX_SQUAD_SIZE, Math.floor(Number(configuredSize) || 4)));
  if (pending > 0) return configured;
  if (assigned >= 2) return Math.max(2, Math.min(configured, assigned));
  return Math.max(2, Math.min(MAX_SQUAD_SIZE, configured));
}

export function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const base = Math.floor(sanitizeFiniteNumber(value, fallback));
  if (!Number.isFinite(min) || !Number.isFinite(max)) return base;
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  return Math.min(upper, Math.max(lower, base));
}

export function getNextModeProfileIndex(value: unknown): number {
  const index = Math.floor(sanitizeFiniteNumber(value, 0));
  return ((index >= 0 ? index : 0) + 1) % 4;
}

export function isMatchmakingRetryAllowed(nextSearchAllowedAt: number, now = Date.now()): boolean {
  return sanitizeFiniteNumber(nextSearchAllowedAt, 0) <= now;
}

export function getNextMatchCountdownSeconds(nextMatchAt: unknown, now = Date.now()): number {
  return Math.max(0, Math.ceil((sanitizeFiniteNumber(nextMatchAt, 0) - now) / 1000));
}

export function getMatchmakingRetryDelayMs(reasonHint: string): number {
  return /\bCANCEL(?:LED|ED)?\b/i.test(reasonHint)
    ? MATCH_CANCEL_RETRY_DELAY_MS
    : MATCHMAKING_REJECTION_BACKOFF_MS;
}

export function isAccountRegistrationRateLimited(status: number, code?: unknown, error?: unknown): boolean {
  return (
    status === 429 ||
    Number(code) === 1006 ||
    /too_many_requests|rate.?limit/i.test(String(error || ''))
  );
}

export function isCleanUdpMatchFinish(reason: unknown): boolean {
  return reason === 'completed';
}

export function extractTeamIdentity(
  decoded: DecodedDict,
  primitiveStrings: Iterable<string> = [],
  primitiveNumbers: Iterable<string | number | bigint> = [],
): { teamCode: string; groupId: string } {
  let teamCode = '';
  let groupId = '';
  const strings = Array.from(primitiveStrings).map((v) => String(v).trim()).filter(Boolean);
  const numbers = Array.from(primitiveNumbers).map((v) => String(v));

  const codeCandidate = [...numbers, ...strings.flatMap((v) => v.match(/\b\d{6,8}\b/g) || [])]
    .find((v) => /^\d{6,8}$/.test(v));
  if (codeCandidate) teamCode = codeCandidate;

  const groupCandidate = strings.find((v) =>
    (/^[0-9a-fA-F-]{20,48}$/.test(v) || /^team[_:-]/i.test(v) || /^group[_:-]/i.test(v))
  );
  if (groupCandidate) groupId = groupCandidate;

  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string') {
        const text = child.trim();
        if (!teamCode && /^\d{6,8}$/.test(text)) teamCode = text;
        if (!groupId && (/^[0-9a-fA-F-]{20,48}$/.test(text) || /^team[_:-]/i.test(text) || /^group[_:-]/i.test(text))) {
          groupId = text;
        }
      } else if (typeof child === 'number' || typeof child === 'bigint') {
        const text = String(child);
        if (!teamCode && /^\d{6,8}$/.test(text)) teamCode = text;
      } else if (typeof child === 'object') {
        visit(child);
      }
    }
  };
  visit(decoded);
  return { teamCode, groupId };
}

export function getSquadProvisioningStatus(
  assignedMembers: number,
  targetSize: number,
  pendingCreations: number,
): 'NEEDS PLAYERS' | 'SQUAD CREATING' | null {
  if (assignedMembers >= targetSize) return null;
  return pendingCreations > 0 ? 'SQUAD CREATING' : 'NEEDS PLAYERS';
}

export function shouldResetSquadMatchCycle(completedMatches: unknown, threshold = MATCH_CYCLE_RESET_AFTER): boolean {
  const matches = Math.floor(sanitizeFiniteNumber(completedMatches, 0));
  return matches >= Math.max(0, threshold);
}

export function resolveSquadLeaderUid(
  peerUids: Iterable<string> | string | null | undefined,
  preferredLeader: string | null,
): string | null {
  const values = peerUids == null ? [] : typeof peerUids === 'string' ? [peerUids] : Array.from(peerUids);
  const candidates = Array.from(new Set(values.map((uid) => String(uid ?? '').trim()).filter(Boolean)));
  if (preferredLeader) {
    const preferred = String(preferredLeader).trim();
    if (preferred && candidates.includes(preferred)) return preferred;
  }
  return candidates[0] || null;
}

export function isSameSquadInvite(
  inviterUid: string | null | undefined,
  inviteGroupId: string | null | undefined,
  currentGroupId: string | null | undefined,
  squadPeerIds: Iterable<string> | null | undefined,
  preferredLeaderUid: string | null,
): boolean {
  if (!inviterUid) return false;
  const inviter = String(inviterUid).trim();
  const peers = squadPeerIds == null ? [] : typeof squadPeerIds === 'string' ? [squadPeerIds] : Array.from(squadPeerIds);
  const allowedInviter = peers.includes(inviter) || String(preferredLeaderUid || '').trim() === inviter;
  if (!allowedInviter) return false;
  const inviteGroup = inviteGroupId == null ? null : String(inviteGroupId).trim() || null;
  const currentGroup = currentGroupId == null ? null : String(currentGroupId).trim() || null;
  return !currentGroup || !inviteGroup || inviteGroup === currentGroup;
}

export function isConfirmedSquadMember(
  memberUid: string | null | undefined,
  rosterUids: Iterable<string> | null | undefined,
  responseGroupId: string | null | undefined,
  expectedGroupId: string | null | undefined,
): boolean {
  const member = String(memberUid ?? '').trim();
  const responseGroup = String(responseGroupId ?? '').trim();
  const expectedGroup = String(expectedGroupId ?? '').trim();
  if (!member || !responseGroup || !expectedGroup || responseGroup !== expectedGroup) return false;
  const roster = rosterUids == null ? [] : typeof rosterUids === 'string' ? [rosterUids] : Array.from(rosterUids);
  const memberSet = new Set(roster.map((uid) => String(uid ?? '').trim()).filter(Boolean));
  return memberSet.has(member);
}

export function sanitizeBotPrefix(raw?: string): string {
  const cleaned = String(raw || 'RDX')
    .replace(/[\r\n\t\0]/g, '')
    .trim()
    .slice(0, 6);
  return cleaned || 'RDX';
}

interface ModeSpec {
  id: GameModeId;
  label: string;
  createMode: number;
  teamType: number;
  queueFlag: number;
  mapsHex: string;
  udpModeId: number;
  udpMapId: number;
}

function getModeSpec(mode: GameModeId, targetSize = 4, profileIdx = 0): ModeSpec {
  const norm = normalizeGameMode(mode);
  if (norm === 'CS_RANK') {
    // Clash Squad Ranked only supports Squad teamType (3), even with 2 or 3 bots.
    // Cycle verified CS Rank mode/queue/map profiles automatically if Free Fire rejects or stalls.
    const profiles: ModeSpec[] = [
      { id: 'CS_RANK', label: 'CS Rank', createMode: 15, teamType: 3, queueFlag: 1, mapsHex: '01090a0b12', udpModeId: 15, udpMapId: 1 },
      { id: 'CS_RANK', label: 'CS Rank', createMode: 15, teamType: 3, queueFlag: 2, mapsHex: '01090a0b1219202729', udpModeId: 15, udpMapId: 1 },
      { id: 'CS_RANK', label: 'CS Rank', createMode: 6, teamType: 3, queueFlag: 2, mapsHex: '01090a0b12', udpModeId: 15, udpMapId: 1 },
      { id: 'CS_RANK', label: 'CS Rank', createMode: 15, teamType: 3, queueFlag: 1, mapsHex: '01090a0b1219202729', udpModeId: 15, udpMapId: 1 },
    ];
    return profiles[Math.abs(profileIdx) % profiles.length];
  }
  const teamType = targetSize === 2 ? 2 : 3;
  return {
    id: 'BR_RANK',
    label: 'BR Rank',
    createMode: 2,
    teamType,
    queueFlag: 2,
    mapsHex: '01090a0b1219202729',
    udpModeId: 2,
    udpMapId: 1,
  };
}

export function getMatchStartModeId(gameMode: GameModeId): number {
  return getModeSpec(gameMode).udpModeId;
}

function nowTime(): string {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function sleep(ms: number, ctrl?: WorkerControl): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      if (ctrl) ctrl.timers.delete(t);
      resolve();
    }, ms);
    if (ctrl) ctrl.timers.add(t);
  });
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(SEED_ACCOUNTS, null, 2), 'utf8');
  }
}

function httpRequest(
  urlStr: string,
  options: {
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: Buffer | string;
    timeoutMs?: number;
  } = {},
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const bodyBuf =
      options.body === undefined
        ? undefined
        : Buffer.isBuffer(options.body)
        ? options.body
        : Buffer.from(options.body, 'utf8');

    const headers: Record<string, string> = { ...(options.headers || {}) };
    if (bodyBuf && !headers['Content-Length'] && !headers['content-length']) {
      headers['Content-Length'] = String(bodyBuf.length);
    }

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : isHttps ? 443 : 80,
        path: parsed.pathname + parsed.search,
        method: options.method || 'GET',
        headers,
        timeout: options.timeoutMs ?? 15000,
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Timeout calling ${parsed.hostname}${parsed.pathname}`));
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function getDeviceForAccount(accKey: string): Record<string, unknown> {
  ensureDataDir();
  let devices: Record<string, Record<string, unknown>> = {};
  if (fs.existsSync(DEVICES_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) devices = parsed;
    } catch {
      devices = {};
    }
  }
  if (devices[accKey]) return devices[accKey];
  const models = [
    ['Samsung', 'SM-G998B', 'Adreno (TM) 660', 'Android OS 12 / API-31'],
    ['Xiaomi', '2201122G', 'Adreno (TM) 730', 'Android OS 13 / API-33'],
    ['Realme', 'RMX3700', 'Mali-G710', 'Android OS 14 / API-34'],
    ['OnePlus', 'CPH2451', 'Adreno (TM) 740', 'Android OS 13 / API-33'],
    ['OPPO', 'CPH2611', 'Adreno (TM) 720', 'Android OS 14 / API-34'],
  ];
  const pick = models[Math.floor(Math.random() * models.length)];
  const dev = {
    unique_device_id: `Google|${crypto.randomUUID()}`,
    brand: pick[0],
    model: pick[1],
    gpu_renderer: pick[2],
    system_software: pick[3],
  };
  devices[accKey] = dev;
  try {
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(devices, null, 2), 'utf8');
  } catch {
    // ignore write errors
  }
  return dev;
}

class RdxEngine {
  accounts = new Map<string, EngineAccountState>();
  credentials = new Map<string, AccountCredentials>();
  workers = new Map<string, WorkerControl>();
  authToGameId = new Map<string, string>();
  gameToAuthId = new Map<string, string>();
  pausedIds = new Set<string>();
  logs: EngineLogEntry[] = [];
  totalMatches = 0;
  matchesStarted = 0;
  totalExpGained = 0;
  creating = false;
  createProgress: string[] = [];
  startTime = Date.now();
  squadRuntimes = new Map<string, SquadRuntime>();
  creationQueue: CreationJob[] = [];
  private activeCreationPending = new Map<string, number>();
  private creationWorkerRunning = false;
  recentDeletedUids = new Set<string>();
  booted = false;
  private cachedVersion: { at: number; data: VersionInfo } | null = null;
  private versionFetchPromise: Promise<VersionInfo | null> | null = null;
  private expiryWatcher: ReturnType<typeof setInterval> | null = null;
  private lastClanAttemptAt = new Map<string, number>();
  private clanHardBlockedReason = new Map<string, string>();
  private loginGateAt = 0;

  log(message: string, level: EngineLogEntry['level'] = 'info'): void {
    const entry: EngineLogEntry = {
      t: Date.now() / 1000,
      time: nowTime(),
      message,
      level,
    };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs = this.logs.slice(-500);
    const prefix = level === 'error' ? '[ERR]' : level === 'warning' ? '[WARN]' : level === 'success' ? '[OK]' : '[INFO]';
    console.log(`${entry.time} ${prefix} ${message}`);
  }

  private linkedIds(uid: string): Set<string> {
    const s = new Set<string>([String(uid)]);
    const g = this.authToGameId.get(uid);
    if (g) s.add(g);
    const a = this.gameToAuthId.get(uid);
    if (a) s.add(a);
    return s;
  }

  private resolveAccountKey(uid: string): string | null {
    if (this.accounts.has(uid)) return uid;
    for (const cand of this.linkedIds(uid)) {
      if (this.accounts.has(cand)) return cand;
    }
    return null;
  }

  isPaused(uid: string): boolean {
    for (const id of this.linkedIds(uid)) {
      if (this.pausedIds.has(id)) return true;
    }
    return false;
  }

  getAccountUptime(uid: string): number {
    const key = this.resolveAccountKey(uid);
    if (!key) return 0;
    const acc = this.accounts.get(key);
    if (!acc) return 0;
    const stopped = acc.is_paused || acc.status === 'OFFLINE' || acc.status === 'BANNED';
    if (stopped && acc.paused_at) {
      return Math.max(0, Math.floor((acc.paused_at - acc.start_time - acc.total_pause_duration) / 1000));
    }
    return Math.max(0, Math.floor((Date.now() - acc.start_time - acc.total_pause_duration) / 1000));
  }

  registerAccount(
    uid: string,
    nickname: string,
    region = 'BD',
    level = 1,
    exp = 0,
    likes = 0,
    authUid?: string,
    meta?: { clan_id?: string; squad_id?: string | null; max_matches?: number; max_hours?: number },
  ): void {
    const uidStr = String(uid);
    const authStr = authUid ? String(authUid) : this.gameToAuthId.get(uidStr) || '';
    if (authStr) {
      this.authToGameId.set(authStr, uidStr);
      this.gameToAuthId.set(uidStr, authStr);
    }
    let placeholder: EngineAccountState | undefined;
    if (authStr && authStr !== uidStr && this.accounts.has(authStr)) {
      placeholder = this.accounts.get(authStr);
      this.accounts.delete(authStr);
    }
    const existing = this.accounts.get(uidStr);
    const pausedNow = this.isPaused(uidStr) || (Boolean(authStr) && this.isPaused(authStr));
    const nowMs = Date.now();
    const initialExp = existing ? existing.initial_exp : exp;
    const gained = Math.max(existing?.gained_exp || 0, Math.max(0, exp - initialExp));
    const matches = existing?.matches || placeholder?.matches || 0;

    this.accounts.set(uidStr, {
      uid: uidStr,
      auth_uid: authStr || existing?.auth_uid,
      nickname: nickname || existing?.nickname || `Player_${uidStr}`,
      region: region || 'BD',
      level: level || existing?.level || 1,
      exp,
      current_exp: exp,
      initial_exp: initialExp,
      gained_exp: gained,
      likes: likes || existing?.likes || 0,
      status: pausedNow ? 'PAUSED' : 'ONLINE',
      is_paused: pausedNow,
      matches,
      matches_played: matches,
      active_matches: existing?.active_matches || 0,
      uptime_seconds: existing ? this.getAccountUptime(uidStr) : 0,
      squad_id: meta?.squad_id ?? existing?.squad_id ?? placeholder?.squad_id ?? null,
      clan_id: meta?.clan_id ?? existing?.clan_id ?? placeholder?.clan_id,
      clan_name: existing?.clan_name ?? placeholder?.clan_name,
      guild_joined: existing?.guild_joined ?? placeholder?.guild_joined ?? false,
      max_matches: meta?.max_matches ?? existing?.max_matches ?? placeholder?.max_matches ?? 0,
      max_hours: meta?.max_hours ?? existing?.max_hours ?? placeholder?.max_hours ?? 0,
      last_match_time: existing?.last_match_time || placeholder?.last_match_time || '',
      start_time: existing?.start_time || placeholder?.start_time || nowMs,
      paused_at: existing?.paused_at ?? placeholder?.paused_at ?? (pausedNow ? nowMs : null),
      total_pause_duration: existing?.total_pause_duration || placeholder?.total_pause_duration || 0,
    });
  }

  updateStatus(uid: string, status: string, activeMatches = 0): void {
    const key = this.resolveAccountKey(uid);
    if (!key) return;
    const acc = this.accounts.get(key);
    if (!acc) return;
    const nowMs = Date.now();
    const stopping = status === 'PAUSED';
    const transientConnectionLoss = status === 'OFFLINE' || status === 'BANNED';
    const keepSquadState =
      Boolean(acc.in_squad || acc.guild_joined) &&
      !stopping &&
      (transientConnectionLoss || status !== 'OFFLINE');
    if (stopping) {
      if (!acc.paused_at) acc.paused_at = nowMs;
    } else if (acc.paused_at && !this.isPaused(key)) {
      acc.total_pause_duration += Math.max(0, nowMs - acc.paused_at);
      acc.paused_at = null;
    }
    if (status === 'SQUAD JOINED') {
      acc.in_squad = true;
      acc.guild_joined = true;
    } else if (status === 'GUILD JOINED') {
      acc.in_squad = Boolean(acc.in_squad && keepSquadState);
      acc.guild_joined = true;
    } else if (status === 'SQUAD JOINING' || status === 'SQUAD CREATING') {
      acc.in_squad = false;
      acc.guild_joined = true;
    } else if (status === 'ONLINE' || status === 'CONNECTING') {
      acc.in_squad = keepSquadState && Boolean(acc.in_squad);
      acc.guild_joined = keepSquadState;
    } else if (transientConnectionLoss) {
      acc.in_squad = Boolean(acc.in_squad);
      acc.guild_joined = Boolean(acc.guild_joined);
    } else if (stopping) {
      acc.in_squad = false;
      acc.guild_joined = false;
    }
    acc.status = status;
    acc.active_matches = activeMatches;
    acc.is_paused = status === 'PAUSED' || this.isPaused(key);
  }

  updateExp(uid: string, exp: number, level?: number): void {
    const key = this.resolveAccountKey(uid);
    if (!key) return;
    const acc = this.accounts.get(key);
    if (!acc) return;
    const old = acc.current_exp || 0;
    if (exp > old) {
      const delta = exp - old;
      acc.gained_exp += delta;
      this.totalExpGained += delta;
    }
    acc.current_exp = exp;
    acc.exp = exp;
    if (level && level > 0) acc.level = level;
  }

  togglePause(uid: string, paused: boolean): void {
    const ids = this.linkedIds(uid);
    const key = this.resolveAccountKey(uid);
    const nowMs = Date.now();
    if (paused) {
      for (const id of ids) this.pausedIds.add(id);
      if (key) {
        const acc = this.accounts.get(key);
        if (acc) {
          if (!acc.is_paused) acc.paused_at = nowMs;
          acc.is_paused = true;
          acc.status = 'PAUSED';
        }
      }
      this.closeSocketsForAccount(uid);
    } else {
      for (const id of ids) this.pausedIds.delete(id);
      if (key) {
        const acc = this.accounts.get(key);
        if (acc) {
          if (acc.paused_at) {
            acc.total_pause_duration += Math.max(0, nowMs - acc.paused_at);
            acc.paused_at = null;
          }
          acc.is_paused = false;
          if (acc.status === 'PAUSED') acc.status = 'ONLINE';
        }
      }
    }
  }

  closeSocketsForAccount(uid: string, fastReconnect = false): void {
    for (const id of this.linkedIds(uid)) {
      const w = this.workers.get(id);
      if (w) {
        if (fastReconnect) w.fastReconnect = true;
        w.mainClosed = true;
        for (const u of w.udpHandles) {
          try {
            u.stop();
          } catch {
            // ignore
          }
        }
        w.udpHandles.clear();
        for (const s of w.sockets) {
          try {
            s.destroy();
          } catch {
            // ignore
          }
        }
        w.sockets.clear();
      }
    }
  }

  loadAccountsDb(): SavedAccountRow[] {
    ensureDataDir();
    try {
      const raw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  saveAccountsDb(rows: SavedAccountRow[]): void {
    ensureDataDir();
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(rows, null, 2), 'utf8');
  }

  private loadLostAccountsDb(): ArchivedAccountRow[] {
    ensureDataDir();
    if (!fs.existsSync(LOST_ACCOUNTS_FILE)) return [];
    try {
      const raw = JSON.parse(fs.readFileSync(LOST_ACCOUNTS_FILE, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch (err) {
      this.log(`Could not read lost account archive: ${(err as Error).message}`, 'error');
      return [];
    }
  }

  private saveLostAccountsDb(rows: ArchivedAccountRow[]): void {
    ensureDataDir();
    fs.writeFileSync(LOST_ACCOUNTS_FILE, JSON.stringify(rows.slice(-1000), null, 2), 'utf8');
  }

  private archiveAccounts(rows: SavedAccountRow[], reason: string): void {
    if (rows.length === 0) return;
    const archived = this.loadLostAccountsDb();
    const byUid = new Map(archived.map((row) => [String(row.uid), row]));
    const removedAt = Date.now();
    for (const row of rows) {
      byUid.set(String(row.uid), { ...row, removed_at: removedAt, removal_reason: reason });
    }
    this.saveLostAccountsDb(Array.from(byUid.values()));
  }

  private getPendingCreationCount(squadId: string): number {
    let pending = this.activeCreationPending.get(squadId) || 0;
    for (const job of this.creationQueue) {
      job.chunkSizes.forEach((size, index) => {
        if (job.squadIds[index] === squadId) pending += size;
      });
    }
    return pending;
  }

  loadGuildsDb(): GuildConfig[] {
    ensureDataDir();
    if (!fs.existsSync(GUILDS_FILE)) return [];
    try {
      const raw = JSON.parse(fs.readFileSync(GUILDS_FILE, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  saveGuildsDb(rows: GuildConfig[]): void {
    ensureDataDir();
    fs.writeFileSync(GUILDS_FILE, JSON.stringify(rows, null, 2), 'utf8');
  }

  loadSquadsDb(): SquadConfig[] {
    ensureDataDir();
    if (!fs.existsSync(SQUADS_FILE)) return [];
    try {
      const raw = JSON.parse(fs.readFileSync(SQUADS_FILE, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  saveSquadsDb(rows: SquadConfig[]): void {
    ensureDataDir();
    fs.writeFileSync(SQUADS_FILE, JSON.stringify(rows, null, 2), 'utf8');
  }

  private getSquadKey(clanId?: string, squadId?: string | null): string {
    if (squadId && String(squadId).trim()) return String(squadId).trim();
    if (clanId && /^\d+$/.test(String(clanId))) return `guild_${String(clanId).trim()}`;
    return 'default_squad';
  }

  private getOrCreateSquadRuntime(squadKey: string, clanId: string): SquadRuntime {
    let rt = this.squadRuntimes.get(squadKey);
    if (!rt) {
      rt = {
        squadKey,
        clanId,
        peers: new Map(),
        leaderUid: null,
        teamCode: null,
        teamGroupId: null,
        teamCreated: false,
        matchSearching: false,
        searchStartedAt: 0,
        searchRetries: 0,
        matchStartedAt: 0,
        lastMatchEndedAt: 0,
        coordinatorRunning: false,
        startingMatchLock: false,
        lastFreshRequestedAt: 0,
        lastRecoveryAt: 0,
        modeProfileIdx: 0,
        modeRevision: 0,
        loopTimer: null,
      };
      this.squadRuntimes.set(squadKey, rt);
    } else if (clanId && !rt.clanId) {
      rt.clanId = clanId;
    }
    return rt;
  }

  private syncHierarchyFromAccounts(): void {
    const accounts = this.loadAccountsDb();
    const guilds = this.loadGuildsDb();
    const squads = this.loadSquadsDb();
    let guildsChanged = false;
    let squadsChanged = false;
    let accountsChanged = false;

    const guildIds = new Set(guilds.map((g) => g.clan_id));
    const squadIds = new Set(squads.map((s) => s.id));

    for (const s of squads) {
      const norm = normalizeGameMode(s.game_mode);
      if (s.game_mode !== norm) {
        s.game_mode = norm;
        squadsChanged = true;
      }
    }

    for (const acc of accounts) {
      const cid = String(acc.clan_id || '').trim();
      if (cid && /^\d+$/.test(cid) && !guildIds.has(cid)) {
        guilds.push({
          clan_id: cid,
          name: `Guild ${cid}`,
          region: 'BD',
          verified: false,
          created_at: Date.now(),
          duration_days: 0,
          duration_hours: 0,
          duration_minutes: 0,
          expires_at: null,
          is_paused: false,
        });
        guildIds.add(cid);
        guildsChanged = true;
      }
      const skey = this.getSquadKey(cid, acc.squad_id);
      if (!acc.squad_id) {
        acc.squad_id = skey;
        accountsChanged = true;
      }
      if (!squadIds.has(skey)) {
        const idx = squads.filter((s) => s.clan_id === cid).length + 1;
        squads.push({
          id: skey,
          clan_id: cid,
          name: `Squad ${idx}`,
          target_size: 4,
          game_mode: 'BR_RANK',
          lobby_delay_sec: 5,
          bot_prefix: sanitizeBotPrefix(acc.bot_prefix),
          is_paused: false,
          created_at: Date.now(),
        });
        squadIds.add(skey);
        squadsChanged = true;
      }
    }

    if (this.enforceSquadCapacity(accounts, squads)) {
      accountsChanged = true;
      squadsChanged = true;
    }

    if (guildsChanged) this.saveGuildsDb(guilds);
    if (squadsChanged) this.saveSquadsDb(squads);
    if (accountsChanged) this.saveAccountsDb(accounts);
  }

  private enforceSquadCapacity(accounts: SavedAccountRow[], squads: SquadConfig[]): boolean {
    const membersBySquad = new Map<string, SavedAccountRow[]>();
    for (const row of accounts) {
      const squadId = String(row.squad_id || '');
      if (!squadId || squadId.startsWith('guild_')) continue;
      const members = membersBySquad.get(squadId) || [];
      members.push(row);
      membersBySquad.set(squadId, members);
    }

    let changed = false;
    for (const [squadId, members] of membersBySquad) {
      if (members.length <= MAX_SQUAD_SIZE) continue;
      const source = squads.find((squad) => squad.id === squadId);
      if (!source) continue;
      source.target_size = MAX_SQUAD_SIZE;
      for (let offset = MAX_SQUAD_SIZE; offset < members.length; offset += MAX_SQUAD_SIZE) {
        const overflow = members.slice(offset, offset + MAX_SQUAD_SIZE);
        const newId = `sq_${crypto.randomUUID().slice(0, 8)}`;
        const squad: SquadConfig = {
          ...source,
          id: newId,
          name: `${source.name} (${Math.floor(offset / MAX_SQUAD_SIZE) + 1})`,
          target_size: Math.min(MAX_SQUAD_SIZE, overflow.length),
          created_at: Date.now(),
        };
        squads.push(squad);
        for (const row of overflow) row.squad_id = newId;
      }
      this.log(`Moved excess players from "${source.name}" to keep each squad at ${MAX_SQUAD_SIZE} players`, 'warning');
      changed = true;
    }
    return changed;
  }

  private loadTokenCache(): Record<string, Record<string, unknown>> {
    ensureDataDir();
    if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
    try {
      return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf8')) || {};
    } catch {
      return {};
    }
  }

  private saveTokenCache(cache: Record<string, Record<string, unknown>>): void {
    try {
      fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
    } catch {
      // ignore
    }
  }

  private getCachedCreds(uid: string): AccountCredentials | null {
    const cache = this.loadTokenCache();
    const row = cache[uid];
    if (!row) return null;
    const cachedAt = Number(row.cached_at || 0);
    if (Date.now() - cachedAt > TOKEN_CACHE_TTL_MS) {
      delete cache[uid];
      this.saveTokenCache(cache);
      return null;
    }
    try {
      return {
        ...(row as unknown as AccountCredentials),
        aes_ak: Buffer.from(String(row.aes_ak_hex), 'hex'),
        iv_i: Buffer.from(String(row.iv_i_hex), 'hex'),
        login_payload_data: Buffer.from(String(row.login_payload_hex), 'hex'),
      };
    } catch {
      return null;
    }
  }

  private setCachedCreds(uid: string, cred: AccountCredentials): void {
    const cache = this.loadTokenCache();
    cache[uid] = {
      ...cred,
      aes_ak: undefined,
      iv_i: undefined,
      login_payload_data: undefined,
      aes_ak_hex: cred.aes_ak.toString('hex'),
      iv_i_hex: cred.iv_i.toString('hex'),
      login_payload_hex: cred.login_payload_data.toString('hex'),
      cached_at: Date.now(),
    };
    this.saveTokenCache(cache);
  }

  private invalidateCache(uid: string): void {
    const cache = this.loadTokenCache();
    if (cache[uid]) {
      delete cache[uid];
      this.saveTokenCache(cache);
    }
  }

  async versionConfig(region = 'BD'): Promise<VersionInfo | null> {
    if (this.cachedVersion && Date.now() - this.cachedVersion.at < 300_000) {
      return this.cachedVersion.data;
    }
    if (this.versionFetchPromise) {
      return this.versionFetchPromise;
    }
    const appVersion = '1.132.9';
    const url =
      `https://version.ggwhitehawk.com/live/ver.php?version=${appVersion}` +
      `&lang=bn&device=android&channel=android&appstore=googleplay` +
      `&region=${region.toUpperCase()}&whitelist_version=1.3.0&whitelist_sp_version=1.0.0`;
    this.versionFetchPromise = (async () => {
      try {
        const res = await httpRequest(url, { timeoutMs: 10000 });
        const j = JSON.parse(res.body.toString('utf8')) as Record<string, string>;
        if (!j.server_url) return null;
        const gops = (j.gop_url || '')
          .split(';')
          .map((x) => x.trim())
          .filter(Boolean);
        const info: VersionInfo = {
          releaseVersion: j.latest_release_version || 'OB55',
          remoteVersion: j.remote_version || appVersion,
          serverUrl: j.server_url,
          gopUrl: gops[0] || 'https://ffmconnect.ppmainecoonghj.com',
          appVersion,
        };
        this.cachedVersion = { at: Date.now(), data: info };
        return info;
      } catch (e) {
        this.log(`[VERCONFIG] ${(e as Error).message}`, 'error');
        return null;
      } finally {
        this.versionFetchPromise = null;
      }
    })();
    return this.versionFetchPromise;
  }

  async getAccessToken(
    uid: string,
    password: string,
  ): Promise<{ openId: string; accessToken: string; platform: number; banned?: boolean } | null> {
    const url = 'https://100067.connect.garena.com/oauth/guest/token/grant';
    const body = new URLSearchParams({
      uid: String(uid),
      password,
      response_type: 'token',
      client_type: '2',
      client_secret: HEX_KEY,
      client_id: '100067',
    }).toString();

    for (let i = 0; i < 3; i++) {
      try {
        const res = await httpRequest(url, {
          method: 'POST',
          headers: {
            Host: '100067.connect.garena.com',
            'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 12; SM-G998B)',
            'Content-Type': 'application/x-www-form-urlencoded',
            Connection: 'close',
          },
          body,
          timeoutMs: 12000,
        });
        const rawText = res.body.toString('utf8');
        if (res.status === 200) {
          const j = JSON.parse(rawText) as {
            open_id?: string;
            access_token?: string;
            platform?: number;
            error?: string;
          };
          if (j.open_id && j.access_token) {
            return { openId: j.open_id, accessToken: j.access_token, platform: Number(j.platform || 4) };
          }
          if (j.error && /ban|suspend/i.test(j.error)) {
            return { openId: '', accessToken: '', platform: 4, banned: true };
          }
        } else if (/error_ban|account_ban|suspended/i.test(rawText)) {
          return { openId: '', accessToken: '', platform: 4, banned: true };
        }
      } catch {
        // retry or fallback
      }
      await sleep(700);
    }

    // Fallback to signed GOP v2 token:grant endpoint
    try {
      const vc = await this.versionConfig('BD');
      const gopBase = vc?.gopUrl || 'https://ffmconnect.ppmainecoonghj.com';
      const grantBody = JSON.stringify({
        client_id: 100067,
        client_secret: HEX_KEY,
        client_type: 2,
        device_id: `02-${crypto.randomUUID()}`,
        password,
        response_type: 'token',
        uid: Number(uid),
      });
      const res = await httpRequest(`${gopBase}/api/v2/oauth/guest/token:grant`, {
        method: 'POST',
        headers: {
          'User-Agent': `GarenaMSDK/4.0.44(SM-E135F ;Android 14;en;GB;app ${vc?.appVersion || '1.132.9'} 2019118525;)`,
          Authorization: `Signature ${generateSignature(grantBody)}`,
          Accept: 'application/json',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: grantBody,
        timeoutMs: 12000,
      });
      const rawText = res.body.toString('utf8');
      if (res.status === 200) {
        const j = JSON.parse(rawText) as {
          code?: number;
          error?: string;
          data?: { open_id?: string; access_token?: string; platform?: number };
        };
        if (j.code === 0 && j.data?.open_id && j.data?.access_token) {
          return {
            openId: j.data.open_id,
            accessToken: j.data.access_token,
            platform: Number(j.data.platform || 4),
          };
        }
        if (j.error && /ban|suspend/i.test(j.error)) {
          return { openId: '', accessToken: '', platform: 4, banned: true };
        }
      } else if (/error_ban|account_ban|suspended/i.test(rawText)) {
        return { openId: '', accessToken: '', platform: 4, banned: true };
      }
    } catch {
      // ignore
    }
    return null;
  }

  buildLoginPayloads(
    accessToken: string,
    openId: string,
    platform: number,
    version: string,
    deviceId: string,
  ): { majorPayload: Buffer; loginPayload: Buffer } {
    const dt = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const majorLogin: Record<string, string | number> = {
      3: dt,
      4: 'free fire',
      5: 1,
      7: version,
      8: 'Android OS 14 / API-34 (UP1A.231005.007/E135FXXSEEZE2)',
      9: 'Handheld',
      11: 'CarrierDataNetwork',
      12: 1672,
      13: 750,
      14: '338',
      15: 'ARMv7 VFPv3 NEON | 2002 | 8',
      16: 3702,
      17: 'Mali-G52',
      18: 'OpenGL ES 3.2 v1.r38p1-01bet0-mbs2v41_0.6d20ec041e51b2f2d25dfc265586ebe8',
      19: deviceId,
      20: '104.28.197.151',
      21: 'bn',
      22: openId,
      23: String(platform),
      24: 'Handheld',
      25: 'samsung SM-E135F',
      26: 'BD',
      29: accessToken,
      30: 1,
      42: 'Cellular',
      57: '7428b253defc164018c604a1ebbfebdf',
      60: 52037,
      61: 5355,
      62: 3723,
      63: 3,
      64: 5483,
      65: 52037,
      66: 5483,
      67: 52037,
      73: 2,
      74: '/data/app/~~yACsV8QOk9OexgajWQP30A==/com.dts.freefireth-Bi_wPVrrhYM2nYncc29q7Q==/lib/arm',
      76: 1,
      77: 'b8e0cd5e295eee42f5860d3c86e483dd|/data/app/~~yACsV8QOk9OexgajWQP30A==/com.dts.freefireth-Bi_wPVrrhYM2nYncc29q7Q==/base.apk',
      78: 3,
      79: 1,
      81: '32',
      83: '2019121229',
      86: 'OpenGLES2',
      87: 8191,
      88: Number(platform),
      92: 16091,
      93: 'android',
      94: 'KqsHT3Yeqo3RLRl8efNiL3aL/1SHwlSrtK0DwNAqdkNBQz70TeVy+icaIwuR3UK4b65Uf3IG5xBFEv0uu+jQZI+rOYCmNCsXjJT4QcZaYgoaaUGG',
      95: 111107,
      96: '{"cur_rate":null,"support_etc2":false}',
      97: 1,
      98: 1,
      99: String(platform),
      100: String(platform),
      102: '4503454457550c0766',
      104: 53792,
      105: 1,
      106: 'https://dl-bs.ggpolarbear.com/live/ABHotUpdates/|https://core-bs.ggpolarbear.com/live/ABHotUpdates/|6b2078db9d22dd98f8e9386a39af8462',
      107: 'c8e41b7a93f02d56e1a94c7b8203f5d1',
    };
    const getLoginData: Record<string, string | number> = {
      ...majorLogin,
      90: 'Dhaka',
      91: 'D',
      99: '0',
      103: 1,
    };
    return {
      majorPayload: aesEncrypt(createProto(majorLogin)),
      loginPayload: aesEncrypt(createProto(getLoginData)),
    };
  }

  async majorLogin(
    payload: Buffer,
    loginUrl: string,
    releaseVersion: string,
  ): Promise<{
    accountId: string;
    jwtToken: string;
    serverUrl: string;
    serverTime: number;
    aesKey: Buffer;
    aesIv: Buffer;
    banned?: boolean;
  } | null> {
    const url = `${loginUrl.replace(/\/+$/, '')}/MajorLogin`;
    try {
      const res = await httpRequest(url, {
        method: 'POST',
        headers: {
          Accept: '*/*',
          Authorization: 'Bearer ',
          'Content-Type': 'application/x-www-form-urlencoded',
          ReleaseVersion: releaseVersion,
          'User-Agent': 'UnityPlayer/2018.4.12f1',
          'X-GA': 'v1 1',
          'X-GA-SV': String(Math.floor(Date.now() / 1000)),
          'X-Unity-Version': '2018.4.12f1',
        },
        body: payload,
        timeoutMs: 15000,
      });
      if (res.status !== 200) {
        this.log(`MajorLogin HTTP ${res.status} from ${new URL(url).hostname} · body ${res.body.length}`, 'warning');
      }
      const httpBody = res.body.toString('utf8');
      if (res.status !== 200 && /ban|suspend/i.test(httpBody) && !/403|rate|limit|cooldown/i.test(httpBody)) {
        return {
          accountId: '',
          jwtToken: '',
          serverUrl: '',
          serverTime: 0,
          aesKey: Buffer.alloc(16),
          aesIv: Buffer.alloc(16),
          banned: true,
        };
      }
      if (res.status !== 200 || res.body.length < 150) {
        const bodyTxt = res.body.toString('utf8');
        if (/ban|suspend/i.test(bodyTxt)) {
          return {
            accountId: '',
            jwtToken: '',
            serverUrl: '',
            serverTime: 0,
            aesKey: Buffer.alloc(16),
            aesIv: Buffer.alloc(16),
            banned: true,
          };
        }
        return null;
      }

      const decrypted = aesDecrypt(res.body);
      const candidateBodies = decrypted
        ? [decrypted, res.body]
        : [res.body];

      let bestFields: Record<number, bigint | Buffer> | null = null;
      let bestDecoded: DecodedDict | null = null;
      let bestScore = -1;
      for (const body of candidateBodies) {
        for (const off of [0, 64, 48, 32, 80, 16, 128, 8, 96, 60, 56, 40, 24, 20, 12, 4]) {
          if (off >= body.length) continue;
          const slice = body.subarray(off);
          const rf = extractRawFields(slice);
          const dec = decodeProtobuf2(slice);
          const hasJwt = typeof dec[8] === 'string' && dec[8].includes('.');
          const hasUrl = typeof dec[10] === 'string' && dec[10].startsWith('http');
          const score = Object.keys(dec).length + (hasJwt ? 100 : 0) + (hasUrl ? 50 : 0);
          if (score > bestScore && hasJwt) {
            bestScore = score;
            bestFields = rf;
            bestDecoded = dec;
            if (hasJwt && hasUrl) break;
          }
        }
        if (bestDecoded && typeof bestDecoded[8] === 'string' && bestDecoded[8].includes('.') &&
            typeof bestDecoded[10] === 'string' && bestDecoded[10].startsWith('http')) break;
      }

      if (!bestFields || !bestDecoded) return null;
      const jwtToken = String(bestDecoded[8] || '');
      const serverUrl = String(bestDecoded[10] || '');
      const accountId = String(bestDecoded[1] || bestFields[1] || '');
      const serverTime = Number(bestDecoded[21] || bestFields[21] || Math.floor(Date.now() / 1000));

      let aesKey: Buffer | null = null;
      let aesIv: Buffer | null = null;
      for (const [kf, vf] of [
        [22, 23],
        [24, 25],
        [6, 7],
      ]) {
        const k = bestFields[kf];
        const v = bestFields[vf];
        if (Buffer.isBuffer(k) && k.length === 16 && Buffer.isBuffer(v) && v.length === 16) {
          aesKey = Buffer.from(k);
          aesIv = Buffer.from(v);
          break;
        }
      }

      if (!jwtToken || !accountId) {
        return null;
      }

      if (serverUrl && (!aesKey || !aesIv)) {
        return null;
      }

      return {
        accountId,
        jwtToken,
        serverUrl,
        serverTime,
        aesKey: aesKey || Buffer.alloc(16),
        aesIv: aesIv || Buffer.alloc(16),
      };
    } catch (e) {
      this.log(`MAJOR-LOGIN ${(e as Error).message}`, 'error');
      return null;
    }
  }

  async chooseRegion(
    region: string,
    jwtToken: string,
    loginUrl: string,
    releaseVersion: string,
  ): Promise<boolean> {
    const url = `${loginUrl.replace(/\/+$/, '')}/ChooseRegion`;
    const payload = aesEncrypt(createProto({ 1: region.toUpperCase() }));
    try {
      const res = await httpRequest(url, {
        method: 'POST',
        headers: {
          'Accept-Encoding': 'gzip',
          Authorization: `Bearer ${jwtToken}`,
          Connection: 'Keep-Alive',
          'Content-Type': 'application/x-www-form-urlencoded',
          ReleaseVersion: releaseVersion,
          'User-Agent': 'UnityPlayer/2018.4.12f1',
          'X-GA': 'v1 1',
          'X-GA-SV': String(Math.floor(Date.now() / 1000)),
          'X-Unity-Version': '2018.4.12f1',
        },
        body: payload,
        timeoutMs: 15000,
      });
      this.log(`CHOOSE-REGION ${region.toUpperCase()} -> HTTP ${res.status}`, res.status === 200 ? 'info' : 'warning');
      return res.status === 200;
    } catch (e) {
      this.log(`CHOOSE-REGION ${(e as Error).message}`, 'error');
      return false;
    }
  }

  async getLoginData(
    payload: Buffer,
    jwtToken: string,
    serverUrl: string,
    releaseVersion: string,
  ): Promise<DecodedDict | null> {
    const url = `${serverUrl.replace(/\/+$/, '')}/GetLoginData`;
    try {
      const res = await httpRequest(url, {
        method: 'POST',
        headers: {
          Accept: '*/*',
          Authorization: `Bearer ${jwtToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          ReleaseVersion: releaseVersion,
          'User-Agent': 'UnityPlayer/2018.4.12f1',
          'X-GA': 'v1 1',
          'X-GA-SV': String(Math.floor(Date.now() / 1000)),
          'X-Unity-Version': '2018.4.12f1',
        },
        body: payload,
        timeoutMs: 12000,
      });
      if (res.status !== 200) return null;
      for (const off of [0, 64, 48, 32, 80, 16, 128, 8, 96]) {
        if (off >= res.body.length) continue;
        const dec = decodeProtobuf2(res.body.subarray(off));
        if (Object.keys(dec).length >= 3 && (dec[14] || dec[32] || dec[4])) {
          return dec;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  async getPlayerPersonalShow(
    targetUid: string,
    jwtToken: string,
    serverUrl: string,
    releaseVersion: string,
  ): Promise<DecodedDict | null> {
    const url = `${serverUrl.replace(/\/+$/, '')}/GetPlayerPersonalShow`;
    const payload = aesEncrypt(createProto({ 1: BigInt(targetUid) }));
    try {
      const res = await httpRequest(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${jwtToken}`,
          host: serverUrl.replace(/^https?:\/\//, '').split('/')[0],
          'x-ga': 'v1 1',
          'content-type': 'application/x-www-form-urlencoded',
          releaseversion: releaseVersion,
          'user-agent': 'UnityPlayer/2022.3.47f1',
          accept: '*/*',
          'x-unity-version': '2022.3.47f1',
        },
        body: payload,
        timeoutMs: 8000,
      });
      if (res.status !== 200) return null;
      return decodeProtobuf2(res.body);
    } catch {
      return null;
    }
  }

  private buildGameHeaders(cred: AccountCredentials): Record<string, string> {
    const base = (cred.server_url || 'https://clientbp.ppmainecoonghj.com').replace(/\/+$/, '');
    const host = base.replace(/^https?:\/\//, '').split('/')[0];
    return {
      Authorization: `Bearer ${cred.token}`,
      Host: host,
      'X-Unity-Version': '2018.4.12f1',
      'X-GA': 'v1 1',
      ReleaseVersion: cred.release_version || 'OB55',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'UnityPlayer/2018.4.12f1',
      Accept: '*/*',
    };
  }

  private getAnyLiveCredential(): AccountCredentials | null {
    for (const c of this.credentials.values()) {
      if (c.token && c.server_url) return c;
    }
    const cache = this.loadTokenCache();
    for (const k of Object.keys(cache)) {
      const c = this.getCachedCreds(k);
      if (c && c.token && c.server_url) return c;
    }
    return null;
  }

  private persistVerifiedClanName(clanId: string, clanName: string, region = 'BD'): void {
    if (!clanId || !clanName) return;
    const guilds = this.loadGuildsDb();
    const g = guilds.find((x) => x.clan_id === String(clanId));
    if (g && (g.name !== clanName || !g.verified)) {
      g.name = clanName;
      g.region = region || g.region || 'BD';
      g.verified = true;
      this.saveGuildsDb(guilds);
    }
  }

  async lookupClanReal(clanId: string): Promise<{ found: boolean; clan_id: string; name?: string; region?: string }> {
    const cleanId = String(clanId || '').trim();
    if (!cleanId || !/^\d+$/.test(cleanId)) return { found: false, clan_id: cleanId };
    const cred = this.getAnyLiveCredential();
    if (!cred) {
      return { found: false, clan_id: cleanId };
    }
    const res = await this.searchClan(cred, cleanId);
    if (res.found && res.clanName) {
      return { found: true, clan_id: cleanId, name: res.clanName, region: res.region || 'BD' };
    }
    return { found: false, clan_id: cleanId };
  }

  async searchClan(
    cred: AccountCredentials,
    clanId: string,
  ): Promise<{ found: boolean; clanName?: string; region?: string }> {
    if (!clanId || !/^\d+$/.test(clanId)) return { found: false };
    const baseUrl = (cred.server_url || 'https://clientbp.ppmainecoonghj.com').replace(/\/+$/, '');
    const payload = aesEncrypt(createProto({ 1: BigInt(clanId) }));
    try {
      const res = await httpRequest(`${baseUrl}/GetClanInfoByClanID`, {
        method: 'POST',
        headers: this.buildGameHeaders(cred),
        body: payload,
        timeoutMs: 10000,
      });
      if (res.status === 200 && res.body.length > 0) {
        const dec = decodeProtobuf2(res.body);
        const cid = dec[1] ? String(dec[1]) : '';
        const clanName = typeof dec[2] === 'string' && dec[2] ? dec[2] : `Clan_${clanId}`;
        const region = typeof dec[13] === 'string' && dec[13] ? dec[13] : 'BD';
        if (cid === clanId || dec[2]) {
          this.log(`CLAN Search UID ${clanId} -> "${clanName}" (${region}) | ${cred.nickname}`, 'info');
          this.persistVerifiedClanName(clanId, clanName, region);
          const acc = this.accounts.get(cred.account_id);
          if (acc) {
            acc.clan_id = clanId;
            acc.clan_name = clanName;
          }
          return { found: true, clanName, region };
        }
      }
      this.log(`CLAN Search ${clanId} failed (HTTP ${res.status})`, 'warning');
    } catch (e) {
      this.log(`CLAN Search ${clanId} err: ${(e as Error).message}`, 'warning');
    }
    return { found: false };
  }

  async checkGuildMembership(
    cred: AccountCredentials,
    targetClanId: string,
  ): Promise<{ joined: boolean; currentClanId?: string; clanName?: string }> {
    const data = await this.getPlayerPersonalShow(
      cred.account_id,
      cred.token,
      cred.server_url,
      cred.release_version,
    );
    if (!data) return { joined: false };
    const f6 = data[6] && typeof data[6] === 'object' ? (data[6] as DecodedDict) : null;
    if (!f6 || !f6[1]) return { joined: false };
    const currentClanId = String(f6[1]);
    const clanName = typeof f6[2] === 'string' ? f6[2] : undefined;
    const joined = currentClanId === String(targetClanId);
    if (joined && clanName) {
      this.persistVerifiedClanName(currentClanId, clanName, 'BD');
    }
    const acc = this.accounts.get(cred.account_id);
    if (acc && joined) {
      acc.clan_id = currentClanId;
      acc.clan_name = clanName || acc.clan_name;
      acc.guild_joined = true;
    }
    return { joined, currentClanId, clanName };
  }

  private decodeClanErrorSnippet(body: Buffer): string {
    if (!body || body.length === 0) return '';
    const tokens = new Set<string>();
    try {
      const prim = extractProtoPrimitives(body);
      for (const s of prim.strings) {
        const clean = s.replace(/[^\x20-\x7e]/g, '').trim();
        if (clean.length >= 3) tokens.add(clean);
      }
      for (const n of prim.numbers) {
        tokens.add(n);
      }
    } catch {
      // ignore protobuf parse error
    }
    const rawText = body.toString('utf8').replace(/[^\x20-\x7e]+/g, ' ').trim();
    if (rawText && rawText.length <= 160 && /[a-zA-Z0-9_]/.test(rawText)) {
      tokens.add(rawText);
    }
    return Array.from(tokens).slice(0, 4).join(' | ');
  }

  private async leaveClan(cred: AccountCredentials, currentClanId: string): Promise<boolean> {
    if (!currentClanId || !/^\d+$/.test(currentClanId)) return false;
    const baseUrl = (cred.server_url || 'https://clientbp.ppmainecoonghj.com').replace(/\/+$/, '');
    const payloads = [
      aesEncrypt(createProto({ 1: BigInt(currentClanId) })),
      aesEncrypt(Buffer.alloc(0)),
    ];
    for (const ep of ['/QuitClan', '/LeaveClan']) {
      for (const body of payloads) {
        try {
          const res = await httpRequest(`${baseUrl}${ep}`, {
            method: 'POST',
            headers: this.buildGameHeaders(cred),
            body,
            timeoutMs: 8000,
          });
          if (res.status === 200) {
            this.log(`CLAN left previous guild ${currentClanId} via ${ep} (${cred.nickname})`, 'info');
            const acc = this.accounts.get(cred.account_id);
            if (acc) acc.guild_joined = false;
            return true;
          }
        } catch {
          // try next
        }
      }
    }
    return false;
  }

  private async tryJoinClan(
    cred: AccountCredentials,
    clanId: string,
    opts?: { quiet?: boolean },
  ): Promise<{
    ok: boolean;
    status?: number;
    reason?: string;
    alreadyRequested?: boolean;
    alreadyInOtherClan?: boolean;
    hardBlocked?: boolean;
  }> {
    if (!clanId || !/^\d+$/.test(clanId)) return { ok: false, reason: 'invalid_clan_id', hardBlocked: true };
    const baseUrl = (cred.server_url || 'https://clientbp.ppmainecoonghj.com').replace(/\/+$/, '');
    const host = baseUrl.replace(/^https?:\/\//, '').split('/')[0];
    const payloads = [
      aesEncrypt(createProto({ 1: BigInt(clanId) })),
      aesEncrypt(createProto({ 1: BigInt(clanId), 2: '' })),
    ];
    const headerVariants: Record<string, string>[] = [
      this.buildGameHeaders(cred),
      {
        Authorization: `Bearer ${cred.token}`,
        Host: host,
        'X-Unity-Version': '2022.3.47f1',
        'X-GA': 'v1 1',
        ReleaseVersion: cred.release_version || 'OB55',
        'Content-Type': 'application/octet-stream',
        'User-Agent': 'UnityPlayer/2022.3.47f1',
        Accept: '*/*',
      },
    ];

    let lastStatus = 0;
    let lastReason = '';

    for (const ep of ['/JoinClan', '/RequestJoinClan']) {
      for (const body of payloads) {
        for (let hIdx = 0; hIdx < headerVariants.length; hIdx++) {
          try {
            const res = await httpRequest(`${baseUrl}${ep}`, {
              method: 'POST',
              headers: headerVariants[hIdx],
              body,
              timeoutMs: 10000,
            });
            lastStatus = res.status;
            if (res.status === 200) {
              this.clanHardBlockedReason.delete(`${cred.account_id}:${clanId}`);
              if (!opts?.quiet) {
                this.log(`CLAN ${ep} sent for ${clanId} (${cred.nickname})`, 'info');
              }
              return { ok: true, status: 200 };
            }

            if (res.status === 401 || res.status === 403) {
              if (cred.auth_uid) this.invalidateCache(cred.auth_uid);
            }

            const snippet = this.decodeClanErrorSnippet(res.body);
            lastReason = snippet ? `HTTP ${res.status}: ${snippet}` : `HTTP ${res.status}`;

            if (/ALREADY_REQUEST|REQUEST_EXIST|ALREADY_APPL|IN_APPLY/i.test(snippet)) {
              this.clanHardBlockedReason.delete(`${cred.account_id}:${clanId}`);
              return { ok: true, status: res.status, alreadyRequested: true, reason: lastReason };
            }
            if (/ALREADY_IN_CLAN|IN_CLAN/i.test(snippet)) {
              return { ok: false, status: res.status, alreadyInOtherClan: true, reason: lastReason };
            }
            if (/LV|LEVEL|RANK|FULL|LIMIT|CLOSED|CD|COOLDOWN|NOT_FOUND/i.test(snippet)) {
              this.clanHardBlockedReason.set(`${cred.account_id}:${clanId}`, lastReason);
              return { ok: false, status: res.status, hardBlocked: true, reason: lastReason };
            }
            // If primary headers returned 400 (game-level rejection rather than 415/404), no need to retry payload2 with same error unless header format differed
            if (res.status === 404) break;
          } catch (e) {
            lastReason = (e as Error).message;
          }
        }
      }
    }

    if (!opts?.quiet) {
      this.log(
        `CLAN join request failed for ${clanId} (${cred.nickname})${lastReason ? ` [${lastReason}]` : ''}`,
        'info',
      );
    }
    return { ok: false, status: lastStatus, reason: lastReason || 'rejected' };
  }

  async requestJoinClan(cred: AccountCredentials, clanId: string): Promise<boolean> {
    const res = await this.tryJoinClan(cred, clanId);
    return res.ok;
  }

  async ensureGuildJoined(
    cred: AccountCredentials,
    clanId: string,
    ctrl: WorkerControl,
  ): Promise<{ proceed: boolean; joined: boolean }> {
    if (!clanId || !/^\d+$/.test(clanId)) return { proceed: true, joined: true };

    // Fast-path when reconnecting in-process (e.g. mode switch or brief TCP reconnect) for the same already-joined guild
    const curAcc = this.accounts.get(cred.account_id);
    if (curAcc?.guild_joined && String(curAcc.clan_id) === String(clanId)) {
      this.updateStatus(cred.account_id, 'GUILD JOINED', 0);
      return { proceed: true, joined: true };
    }

    // 1. Always search the Guild UID first
    const info = await this.searchClan(cred, clanId);

    // 2. Check if already a member of this Guild (or another Guild)
    const initial = await this.checkGuildMembership(cred, clanId);
    if (initial.joined) {
      this.updateStatus(cred.account_id, 'GUILD JOINED', 0);
      this.log(`GUILD JOINED | ${cred.nickname} -> "${initial.clanName || info.clanName || clanId}"`, 'success');
      return { proceed: true, joined: true };
    }
    if (initial.currentClanId && initial.currentClanId !== clanId) {
      await this.leaveClan(cred, initial.currentClanId);
      await sleep(1000, ctrl);
      if (ctrl.cancelled || this.isPaused(cred.account_id)) return { proceed: false, joined: false };
    }

    // 3. Send join request after searching Guild UID
    this.updateStatus(cred.account_id, 'GUILD JOIN SEND', 0);
    this.lastClanAttemptAt.set(cred.account_id, Date.now());
    let req = await this.tryJoinClan(cred, clanId);
    if (req.alreadyInOtherClan && initial.currentClanId) {
      await this.leaveClan(cred, initial.currentClanId);
      await sleep(1000, ctrl);
      if (!ctrl.cancelled && !this.isPaused(cred.account_id)) {
        req = await this.tryJoinClan(cred, clanId);
      }
    }

    await sleep(1200, ctrl);
    if (ctrl.cancelled || this.isPaused(cred.account_id)) return { proceed: false, joined: false };

    const afterSend = await this.checkGuildMembership(cred, clanId);
    if (afterSend.joined) {
      this.updateStatus(cred.account_id, 'GUILD JOINED', 0);
      this.log(`GUILD JOINED | ${cred.nickname} -> "${afterSend.clanName || info.clanName || clanId}"`, 'success');
      return { proceed: true, joined: true };
    }

    // 4. Bounded wait for auto-join / fast approval without spamming RequestJoinClan every 5s
    if (req.ok || req.alreadyRequested) {
      for (let i = 0; i < 4 && !ctrl.cancelled && !this.isPaused(cred.account_id); i++) {
        await sleep(4000, ctrl);
        if (ctrl.cancelled || this.isPaused(cred.account_id)) return { proceed: false, joined: false };
        const check = await this.checkGuildMembership(cred, clanId);
        if (check.joined) {
          this.updateStatus(cred.account_id, 'GUILD JOINED', 0);
          this.log(
            `GUILD JOINED | ${cred.nickname} -> "${check.clanName || info.clanName || clanId}"`,
            'success',
          );
          return { proceed: true, joined: true };
        }
      }
    } else if (!req.hardBlocked) {
      await sleep(2500, ctrl);
      if (!ctrl.cancelled && !this.isPaused(cred.account_id)) {
        this.lastClanAttemptAt.set(cred.account_id, Date.now());
        req = await this.tryJoinClan(cred, clanId, { quiet: true });
        await sleep(1200, ctrl);
        const retryCheck = await this.checkGuildMembership(cred, clanId);
        if (retryCheck.joined) {
          this.updateStatus(cred.account_id, 'GUILD JOINED', 0);
          this.log(
            `GUILD JOINED | ${cred.nickname} -> "${retryCheck.clanName || info.clanName || clanId}"`,
            'success',
          );
          return { proceed: true, joined: true };
        }
      }
    }

    if (ctrl.cancelled || this.isPaused(cred.account_id)) return { proceed: false, joined: false };

    // 5. Do not deadlock or spam warnings if guild requires manual approval / level / is full;
    // proceed to TCP & squad while checking guild membership cleanly in the background.
    const acc = this.accounts.get(cred.account_id);
    if (acc) acc.guild_joined = false;
    if (req.ok || req.alreadyRequested) {
      this.log(
        `CLAN ${clanId} pending approval for ${cred.nickname} — entering squad while syncing guild status`,
        'info',
      );
    } else {
      this.log(
        `CLAN ${clanId} join deferred for ${cred.nickname}${req.reason ? ` (${req.reason})` : ''} — entering squad & retrying in background`,
        'info',
      );
    }
    return { proceed: true, joined: false };
  }

  async refreshAccountProfile(uidOrCred: string | AccountCredentials): Promise<void> {
    const cred =
      typeof uidOrCred === 'string'
        ? this.credentials.get(uidOrCred) || this.credentials.get(this.authToGameId.get(uidOrCred) || '')
        : uidOrCred;
    if (!cred) return;
    const data = await this.getPlayerPersonalShow(
      cred.account_id,
      cred.token,
      cred.server_url,
      cred.release_version,
    );
    if (!data) return;
    const pd = data[1] && typeof data[1] === 'object' ? (data[1] as DecodedDict) : null;
    if (!pd) return;
    const exp = Number(pd[7]);
    const lvl = Number(pd[6] || 1);
    const nick = typeof pd[3] === 'string' ? pd[3] : undefined;
    if (!Number.isFinite(exp)) return;
    const aid = cred.account_id;
    const acc = this.accounts.get(aid);
    const oldExp = acc?.current_exp || 0;
    this.updateExp(aid, exp, lvl);
    if (acc && nick) acc.nickname = nick;

    if (cred.clan_id && /^\d+$/.test(cred.clan_id)) {
      const f6 = data[6] && typeof data[6] === 'object' ? (data[6] as DecodedDict) : null;
      const curClan = f6 && f6[1] ? String(f6[1]) : '';
      const curClanName = f6 && typeof f6[2] === 'string' ? f6[2] : undefined;
      if (curClan === String(cred.clan_id)) {
        if (acc && !acc.guild_joined) {
          acc.guild_joined = true;
          acc.clan_id = curClan;
          acc.clan_name = curClanName || acc.clan_name;
          if (curClanName) this.persistVerifiedClanName(curClan, curClanName, 'BD');
          this.log(`GUILD JOINED | ${nick || acc.nickname} -> "${curClanName || curClan}"`, 'success');
        }
      } else {
        const lastTry = this.lastClanAttemptAt.get(aid) || 0;
        const blocked = this.clanHardBlockedReason.has(`${aid}:${cred.clan_id}`);
        if (!blocked && Date.now() - lastTry >= 120_000) {
          this.lastClanAttemptAt.set(aid, Date.now());
          void this.tryJoinClan(cred, cred.clan_id, { quiet: true });
        }
      }
    }

    if (exp > oldExp) {
      this.log(`+${(exp - oldExp).toLocaleString()} EXP | ${aid} (${nick || acc?.nickname})`, 'success');
    } else {
      this.log(`Profile synced: ${nick || aid} · L${lvl} · ${exp.toLocaleString()} EXP`, 'info');
    }
  }

  async processGuestLogin(
    uid: string,
    password: string,
    meta?: { clan_id?: string; squad_id?: string | null; max_matches?: number; max_hours?: number },
  ): Promise<AccountCredentials | null> {
    const cached = this.getCachedCreds(uid);
    if (cached) {
      this.registerAccount(cached.account_id, cached.nickname, 'BD', cached.level, cached.exp, cached.likes, uid, meta);
      this.credentials.set(cached.account_id, cached);
      this.credentials.set(uid, cached);
      this.log(`Online (cache): ${cached.account_id} | ${cached.nickname} | Lvl ${cached.level}`, 'success');
      return cached;
    }

    const now = Date.now();
    const waitMs = Math.max(0, this.loginGateAt - now);
    if (waitMs > 0) await sleep(waitMs);
    this.loginGateAt = Date.now() + 650;

    this.log(`LOGIN UID: ${uid}`, 'info');
    const vc = await this.versionConfig('BD');
    if (!vc) return null;

    const tg = await this.getAccessToken(uid, password);
    if (!tg) {
      this.log(`Garena token grant failed for ${uid}`, 'error');
      this.updateStatus(uid, 'CONNECTING', 0);
      return null;
    }
    if (tg.banned) {
      this.log(`Account ${uid} is BANNED/SUSPENDED by Garena — remove & replace in My Squad`, 'error');
      this.invalidateCache(uid);
      this.updateStatus(uid, 'BANNED', 0);
      return null;
    }

    const dev = getDeviceForAccount(uid);
    let { majorPayload, loginPayload } = this.buildLoginPayloads(
      tg.accessToken,
      tg.openId,
      tg.platform,
      vc.remoteVersion,
      String(dev.unique_device_id),
    );

    const loginServers = Array.from(new Set([
      vc.serverUrl,
      'https://loginbp.ppmainecoonghj.com/',
      'https://loginbp.ggblueshark.com/',
    ].filter((value): value is string => Boolean(value))));

    let ml: Awaited<ReturnType<RdxEngine['majorLogin']>> = null;
    for (const loginServer of loginServers) {
      for (let attempt = 0; attempt < 2 && !ml; attempt++) {
        ml = await this.majorLogin(majorPayload, loginServer, vc.releaseVersion);
        if (ml) break;
        await sleep(900);
        const next = this.buildLoginPayloads(
          tg.accessToken,
          tg.openId,
          tg.platform,
          vc.remoteVersion,
          String(dev.unique_device_id),
        );
        majorPayload = next.majorPayload;
        loginPayload = next.loginPayload;
      }
      if (ml) break;
    }

    if (ml?.banned) {
      this.log(`Account ${uid} rejected as BANNED by Free Fire login — remove & replace in My Squad`, 'error');
      this.invalidateCache(uid);
      this.updateStatus(uid, 'BANNED', 0);
      return null;
    }

    if (ml && !ml.serverUrl && ml.jwtToken) {
      this.log(`Choosing region BD for ${uid}...`, 'info');
      await this.chooseRegion('BD', ml.jwtToken, vc.serverUrl, vc.releaseVersion);
      await sleep(1500);
      for (let attempt = 0; attempt < 3; attempt++) {
        const next = this.buildLoginPayloads(
          tg.accessToken,
          tg.openId,
          tg.platform,
          vc.remoteVersion,
          String(dev.unique_device_id),
        );
        loginPayload = next.loginPayload;
        const ml2 = await this.majorLogin(next.majorPayload, vc.serverUrl, vc.releaseVersion);
        if (ml2?.banned) {
          this.log(`Account ${uid} rejected as BANNED by Free Fire login`, 'error');
          this.invalidateCache(uid);
          this.updateStatus(uid, 'BANNED', 0);
          return null;
        }
        if (ml2 && ml2.serverUrl) {
          ml = ml2;
          break;
        }
        await sleep(1500);
      }
    }

    if (!ml || !ml.serverUrl) {
      this.log(`MajorLogin failed for ${uid}`, 'error');
      this.updateStatus(uid, 'CONNECTING', 0);
      return null;
    }

    const ld = await this.getLoginData(loginPayload, ml.jwtToken, ml.serverUrl, vc.releaseVersion);
    if (!ld) {
      this.log(`GetLoginData failed for ${uid}`, 'error');
      this.updateStatus(uid, 'CONNECTING', 0);
      return null;
    }

    const level = Number(ld[6] || 1);
    const exp = Number(ld[7] || 0);
    const likes = Number(ld[8] || 0);
    const nickname = typeof ld[4] === 'string' && ld[4] ? ld[4] : `Player_${ml.accountId}`;
    const funcAddrs = typeof ld[14] === 'string' ? ld[14] : '';
    const infoAddrs = typeof ld[32] === 'string' ? ld[32] : '';

    const cred: AccountCredentials = {
      account_id: ml.accountId,
      nickname,
      region: 'BD',
      level,
      exp,
      likes,
      open_id: tg.openId,
      access_token: tg.accessToken,
      platform: String(tg.platform),
      token: ml.jwtToken,
      server_time: ml.serverTime,
      aes_ak: ml.aesKey,
      iv_i: ml.aesIv,
      functional_addrs: funcAddrs,
      informational_addrs: infoAddrs,
      release_version: vc.releaseVersion,
      client_version: vc.remoteVersion,
      server_url: ml.serverUrl,
      login_payload_data: loginPayload,
      auth_type: 'guest',
      auth_uid: uid,
      auth_password: password,
      clan_id: meta?.clan_id,
      squad_id: meta?.squad_id || undefined,
      max_matches: meta?.max_matches || 0,
      max_hours: meta?.max_hours || 0,
    };

    this.registerAccount(ml.accountId, nickname, 'BD', level, exp, likes, uid, meta);
    this.credentials.set(ml.accountId, cred);
    this.credentials.set(uid, cred);
    this.setCachedCreds(uid, cred);
    this.log(`Login OK: ${ml.accountId} | ${nickname} | Lvl ${level} | EXP ${exp.toLocaleString()}`, 'success');
    return cred;
  }

  private buildTcpStartupPacket(cred: AccountCredentials, typ: 'OnLine' | 'ChaT'): Buffer {
    const uidHex = BigInt(cred.account_id).toString(16).padStart(16, '0');
    const tsHex = BigInt(cred.server_time).toString(16).padStart(8, '0');
    const encHex = aesEncrypt(Buffer.from(cred.token, 'utf8'), cred.aes_ak, cred.iv_i).toString('hex');
    const encLen = (encHex.length / 2).toString(16).padStart(8, '0');
    if (typ === 'OnLine') {
      return Buffer.from(`7219${uidHex}${tsHex}00000000${encLen}${encHex}`, 'hex');
    }
    return Buffer.from(`8119${uidHex}${tsHex}${encLen}${encHex}`, 'hex');
  }

  private buildCreateTeamPacket(
    cred: AccountCredentials,
    gameMode: GameModeId = 'BR_RANK',
    targetSize = 4,
    profileIdx = 0,
  ): Buffer {
    const spec = getModeSpec(gameMode, targetSize, profileIdx);
    const fields = {
      1: 1,
      2: {
        2: Buffer.from('01', 'hex'),
        3: spec.createMode,
        4: spec.teamType,
        5: 'en',
        8: { 1: 'IDC3', 2: 123, 3: 'BD' },
        9: spec.queueFlag,
        10: Buffer.from(spec.mapsHex, 'hex'),
        11: 2,
        13: 1,
        14: {
          1: '08FBA33B4BABE2790205390333330000009700050092005F72697EB2134DCBB2467625142201040e38e848dc0e748c3f6aa04d81000000ff1113090dcacfa16d',
          2: 478,
          3: '7e585d55',
          4: 'y[Z]',
          6: 12,
          7: '15686677735a7506101c',
          8: cred.client_version || '1.132.21',
          9: 3,
          10: 1,
          11: '03626253513637754174',
        },
        19: 329,
        21: Buffer.from('374f521955', 'hex'),
        24: { 1: 21 },
        27: 'a_6534489873065906362',
      },
    };
    return createPacket(createProto(fields).toString('hex'), '0515', cred.aes_ak, cred.iv_i);
  }

  private buildTeamFreshPacket(cred: AccountCredentials): Buffer {
    return createPacket(
      createProto({ 1: 72, 2: { 1: BigInt(cred.account_id) } }).toString('hex'),
      '0515',
      cred.aes_ak,
      cred.iv_i,
    );
  }

  private buildInviteTeamPacket(cred: AccountCredentials, targetUid: string): Buffer {
    return createPacket(
      createProto({ 1: 2, 2: { 1: BigInt(targetUid), 2: 'BD', 4: 1 } }).toString('hex'),
      '0515',
      cred.aes_ak,
      cred.iv_i,
    );
  }

  private buildAcceptTeamInvitePacket(cred: AccountCredentials, leaderUid: string, groupId: string): Buffer {
    const fields = {
      1: 4,
      2: {
        1: BigInt(leaderUid),
        3: BigInt(leaderUid),
        4: Buffer.from('0107090a0b120f19202729', 'hex'),
        8: 1,
        9: {
          1: '08FBA33B0522052002041B0222220007000C00010004000547E265AE1080779546762514110104076fa2e8770e748c3f6a68ed75000000ff08080500cacfa16d',
          2: 235,
          3: { 14: 80, 11: 86 },
          4: '{Y\\R',
          6: 13,
          7: { 2: 4 },
          8: cred.client_version || '1.132.21',
          9: 2,
          10: 1,
          11: '0362625351',
        },
        10: String(groupId),
        11: { 1: 'IDC3', 2: 107, 3: 'BD' },
        13: 'en',
        16: '374f5219',
        20: { 1: 21 },
        23: 'a_6534489873065906362',
        24: 'https://dl-sg-production.freefiremobile.com/',
        27: { 1: 2, 2: 4 },
      },
    };
    return createPacket(createProto(fields).toString('hex'), '0515', cred.aes_ak, cred.iv_i);
  }

  private buildReadyPacket(cred: AccountCredentials): Buffer {
    return createPacket(
      createProto({ 1: 15, 2: { 1: BigInt(cred.account_id), 2: 1 } }).toString('hex'),
      '0519',
      cred.aes_ak,
      cred.iv_i,
    );
  }

  private buildStartMatchTeamPacket(cred: AccountCredentials, gameMode: GameModeId): Buffer {
    const modeId = getModeSpec(gameMode).udpModeId;
    return createPacket(
      createProto({ 1: 9, 2: { 1: BigInt(cred.account_id), 7: { 1: 'IDC3', 2: modeId, 3: 'BD' } } }).toString('hex'),
      '0515',
      cred.aes_ak,
      cred.iv_i,
    );
  }

  private dictContainsUid(obj: unknown, uid: string, depth = 0): boolean {
    if (depth > 5 || obj === null || obj === undefined) return false;
    if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'bigint') {
      return String(obj) === uid;
    }
    if (typeof obj === 'object') {
      for (const val of Object.values(obj as Record<string, unknown>)) {
        if (this.dictContainsUid(val, uid, depth + 1)) return true;
      }
    }
    return false;
  }

  private getPendingCreationCountForSquad(squadKey: string, clanId?: string): number {
    let pending = this.activeCreationPending.get(squadKey) || 0;
    for (const job of this.creationQueue) {
      if (clanId && job.clanId !== clanId) continue;
      job.chunkSizes.forEach((sz, idx) => {
        if (job.squadIds[idx] === squadKey) {
          pending += sz;
        }
      });
    }
    return pending;
  }

  private getExpectedSquadCount(squadKey: string, clanId: string): number {
    const squads = this.loadSquadsDb();
    const cfg = squads.find((s) => s.id === squadKey && s.clan_id === clanId);
    const dbRows = this.loadAccountsDb().filter(
      (a) =>
        a.clan_id === clanId &&
        this.getSquadKey(a.clan_id, a.squad_id) === squadKey &&
        !this.isPaused(String(a.uid)) &&
        !a.replacement_pending_match,
    );
    const pending = this.getPendingCreationCountForSquad(squadKey, clanId);
    if (cfg && cfg.target_size >= 2) {
      return getEffectiveSquadSize(cfg.target_size, dbRows.length, pending);
    }
    return Math.max(2, Math.min(4, dbRows.length || 2));
  }

  private getSquadLobbyDelayMs(squadKey: string): number {
    const cfg = this.loadSquadsDb().find((s) => s.id === squadKey);
    const sec = Math.max(0, Math.min(120, Number(cfg?.lobby_delay_sec ?? 5)));
    return sec * 1000;
  }

  private getSquadMode(squadKey: string): GameModeId {
    const cfg = this.loadSquadsDb().find((s) => s.id === squadKey);
    return normalizeGameMode(cfg?.game_mode);
  }

  private isGuildActiveForBot(clanId?: string): boolean {
    if (!clanId) return true;
    const guilds = this.loadGuildsDb();
    const g = guilds.find((x) => x.clan_id === String(clanId));
    if (!g) return true;
    if (g.is_paused) return false;
    if (g.expires_at !== null && Date.now() >= g.expires_at) return false;
    return true;
  }

  private isSquadActive(squadKey: string): boolean {
    if (squadKey === 'default_squad') return false;
    const squads = this.loadSquadsDb();
    const s = squads.find((x) => x.id === squadKey);
    if (!s || s.is_paused) return false;
    const guild = this.loadGuildsDb().find((x) => x.clan_id === s.clan_id);
    if (guild?.is_paused || (guild?.expires_at !== null && guild?.expires_at !== undefined && Date.now() >= guild.expires_at)) {
      return false;
    }
    return true;
  }

  private clearSquadLoop(rt: SquadRuntime): void {
    if (rt.loopTimer) {
      clearInterval(rt.loopTimer);
      rt.loopTimer = null;
    }
  }

  private rebuildSquadSession(squadKey: string, reason: string, rotateProfile = false): void {
    const rt = this.squadRuntimes.get(squadKey);
    const cfg = this.loadSquadsDb().find((s) => s.id === squadKey);
    const label = cfg?.name || squadKey;
    if (rt) {
      this.clearSquadLoop(rt);
      rt.modeRevision += 1;
      if (rotateProfile) {
        rt.modeProfileIdx = (rt.modeProfileIdx + 1) % 4;
      }
      rt.teamCreated = false;
      rt.matchSearching = false;
      rt.searchStartedAt = 0;
      rt.searchRetries = 0;
      rt.matchStartedAt = 0;
      rt.lastMatchEndedAt = 0;
      rt.teamCode = null;
      rt.teamGroupId = null;
      rt.leaderUid = null;
      rt.coordinatorRunning = false;
      rt.startingMatchLock = false;
      rt.peers.clear();
    }

    const dbRows = this.loadAccountsDb().filter((a) => this.getSquadKey(a.clan_id, a.squad_id) === squadKey);
    this.log(`[${label}] Rebuilding squad session (${reason}) for ${dbRows.length} bot(s)...`, 'info');
    for (const row of dbRows) {
      const uid = String(row.uid);
      if (this.isPaused(uid)) continue;
      const w = this.workers.get(uid) || this.workers.get(this.authToGameId.get(uid) || '');
      if (w && !w.cancelled) {
        this.closeSocketsForAccount(uid, true);
      } else {
        this.startGuestWorker(row);
      }
    }
  }

  private requestLeaderTeamFresh(rt: SquadRuntime): void {
    const now = Date.now();
    if (now - rt.lastFreshRequestedAt < 500) return;
    const ldr = rt.leaderUid ? rt.peers.get(rt.leaderUid) : undefined;
    if (!ldr || ldr.socket.destroyed || ldr.ctrl.cancelled || this.isPaused(ldr.uid)) return;
    rt.lastFreshRequestedAt = now;
    try {
      ldr.socket.write(this.buildTeamFreshPacket(ldr.cred));
    } catch {
      // ignore
    }
  }

  private async triggerSquadStartMatch(rt: SquadRuntime, squadLabel: string, expected: number): Promise<boolean> {
    if (rt.startingMatchLock) return false;
    const delayMs = this.getSquadLobbyDelayMs(rt.squadKey);
    if (rt.lastMatchEndedAt > 0 && Date.now() - rt.lastMatchEndedAt < delayMs) {
      return false;
    }
    const startRev = rt.modeRevision;
    rt.startingMatchLock = true;
    try {
      const leader = rt.leaderUid ? rt.peers.get(rt.leaderUid) : undefined;
      if (!leader || leader.socket.destroyed || !leader.guildJoined || !leader.inSquad || this.isPaused(leader.uid)) {
        return false;
      }
      const requiredCount = Math.max(2, Math.min(4, expected));
      const squadMembers = Array.from(rt.peers.values())
        .filter((p) => !p.socket.destroyed && !this.isPaused(p.uid) && p.guildJoined && p.inSquad)
        .slice(0, requiredCount);
      if (squadMembers.length < requiredCount || squadMembers.length < 2) {
        return false;
      }
      if (Array.from(rt.peers.values()).some((p) => this.accounts.get(p.uid)?.status === 'IN_MATCH')) {
        return false;
      }

      const modeId = this.getSquadMode(rt.squadKey);
      const modeSpec = getModeSpec(modeId, requiredCount, rt.modeProfileIdx);
      rt.matchSearching = true;
      rt.searchStartedAt = Date.now();
      rt.lastMatchEndedAt = 0;
      this.log(
        `[${squadLabel}] ALL ${squadMembers.length}/${requiredCount} In Squad [${modeSpec.label}${modeId === 'CS_RANK' ? ` #${(rt.modeProfileIdx % 4) + 1}` : ''}] (Code ${rt.teamCode || 'N/A'}) -> Ready & Starting Match!`,
        'success',
      );

      for (const p of squadMembers) {
        if (rt.modeRevision !== startRev || p.ctrl.cancelled) break;
        this.updateStatus(p.uid, 'SEARCHING', 0);
        if (!p.socket.destroyed) {
          try {
            p.socket.write(this.buildReadyPacket(p.cred));
          } catch {
            // ignore
          }
          await sleep(100, p.ctrl);
        }
      }

      await sleep(750);

      // Final full-roster & revision check before leader presses Start Match
      const stillReady = Array.from(rt.peers.values()).filter(
        (p) => !p.socket.destroyed && !this.isPaused(p.uid) && p.guildJoined && p.inSquad,
      );
      if (
        rt.modeRevision !== startRev ||
        stillReady.length < requiredCount ||
        leader.socket.destroyed ||
        !leader.inSquad ||
        !rt.teamCreated ||
        !rt.matchSearching
      ) {
        if (rt.modeRevision === startRev) {
          rt.matchSearching = false;
          rt.searchStartedAt = 0;
          for (const p of stillReady) {
            if (this.accounts.get(p.uid)?.status === 'SEARCHING') {
              this.updateStatus(p.uid, 'SQUAD JOINED', 0);
            }
          }
        }
        return false;
      }

      leader.socket.write(this.buildStartMatchTeamPacket(leader.cred, modeId));
      return true;
    } catch {
      return false;
    } finally {
      rt.startingMatchLock = false;
    }
  }

  private async runSquadCoordinator(squadKey: string): Promise<void> {
    const rt = this.squadRuntimes.get(squadKey);
    if (!rt || rt.coordinatorRunning) return;
    if (!this.isGuildActiveForBot(rt.clanId) || !this.isSquadActive(squadKey)) return;

    const coordRev = rt.modeRevision;
    rt.coordinatorRunning = true;
    const squadCfg = this.loadSquadsDb().find((s) => s.id === squadKey);
    const squadLabel = squadCfg?.name || squadKey;
    const gameMode = normalizeGameMode(squadCfg?.game_mode);

    try {
      const expected = this.getExpectedSquadCount(squadKey, rt.clanId);
      let eligible: PeerEntry[] = [];

      // 1. Wait until ALL expected players in this squad are Guild Joined + TCP ready
      for (let wait = 0; wait < 25; wait++) {
        if (rt.modeRevision !== coordRev) return;
        if (!this.isGuildActiveForBot(rt.clanId) || !this.isSquadActive(squadKey)) return;
        const now = Date.now();
        eligible = Array.from(rt.peers.values())
          .filter(
            (p) =>
              !p.ctrl.cancelled &&
              !p.socket.destroyed &&
              !this.isPaused(p.uid) &&
              p.guildJoined &&
              now >= p.readyAt,
          )
          .slice(0, expected);
        if (eligible.length >= expected && eligible.length >= 2) break;
        await sleep(1000);
      }

      if (rt.modeRevision !== coordRev) return;
      if (eligible.length < expected || eligible.length < 2) {
        this.log(
          `[${squadLabel}] Waiting for all ${expected} bots (${eligible.length}/${expected} ready)`,
          'info',
        );
        setTimeout(() => void this.runSquadCoordinator(squadKey), 3500);
        return;
      }

      // 2. Pick or verify Squad Leader & create Squad ONLY if no live group exists
      const existingLeader = rt.leaderUid ? rt.peers.get(rt.leaderUid) : undefined;
      let leader: PeerEntry;

      if (
        rt.teamCreated &&
        rt.teamGroupId &&
        existingLeader &&
        !existingLeader.socket.destroyed &&
        !this.isPaused(existingLeader.uid) &&
        existingLeader.guildJoined
      ) {
        leader = existingLeader;
        leader.inSquad = true;
      } else {
        leader =
          existingLeader && !existingLeader.socket.destroyed && existingLeader.guildJoined
            ? existingLeader
            : eligible[0];
        rt.leaderUid = leader.uid;
        rt.teamCode = null;
        rt.teamGroupId = null;
        rt.teamCreated = false;
        rt.matchSearching = false;
        rt.searchStartedAt = 0;
        rt.searchRetries = 0;
        for (const p of rt.peers.values()) p.inSquad = false;

        if (leader.socket.destroyed || leader.ctrl.cancelled || this.isPaused(leader.uid)) return;

        const modeSpec = getModeSpec(gameMode, expected, rt.modeProfileIdx);
        this.updateStatus(leader.uid, 'SQUAD CREATING', 0);
        this.log(
          `[${squadLabel}] SQUAD CREATING [${modeSpec.label}${gameMode === 'CS_RANK' ? ` #${(rt.modeProfileIdx % 4) + 1}` : ''}] | Leader: ${leader.cred.nickname} (${leader.uid})`,
          'info',
        );
        leader.socket.write(this.buildCreateTeamPacket(leader.cred, gameMode, expected, rt.modeProfileIdx));
        await sleep(900);
        if (rt.modeRevision !== coordRev) return;
        if (!leader.socket.destroyed) {
          leader.socket.write(this.buildTeamFreshPacket(leader.cred));
        }

        for (let i = 0; i < 24; i++) {
          if (rt.modeRevision !== coordRev) return;
          if (rt.teamGroupId && rt.teamCode) break;
          if ((i === 9 || i === 17) && !leader.socket.destroyed) {
            leader.socket.write(this.buildTeamFreshPacket(leader.cred));
          }
          await sleep(300);
        }

        if (rt.modeRevision !== coordRev) return;
        if (!rt.teamGroupId) {
          this.log(`[${squadLabel}] Group ID not received yet — retrying create/fresh without disconnecting the squad`, 'warning');
          if (!leader.socket.destroyed) {
            leader.socket.write(this.buildCreateTeamPacket(leader.cred, gameMode, expected, rt.modeProfileIdx));
            setTimeout(() => {
              if (!leader.socket.destroyed && rt.modeRevision === coordRev) {
                leader.socket.write(this.buildTeamFreshPacket(leader.cred));
              }
            }, 1200);
          }
          setTimeout(() => {
            if (rt.modeRevision === coordRev && this.isSquadActive(squadKey)) {
              void this.runSquadCoordinator(squadKey);
            }
          }, 5000);
          return;
        }
        rt.teamCreated = true;
        leader.inSquad = true;
      }

      // 3. Sequentially bring ALL remaining eligible members into the SAME Free Fire group
      for (let round = 0; round < 8; round++) {
        if (rt.modeRevision !== coordRev) return;
        if (round > 0 && !leader.socket.destroyed) {
          leader.socket.write(this.buildTeamFreshPacket(leader.cred));
          await sleep(650);
        }

        const pendingMembers = eligible.filter(
          (p) => p.uid !== leader.uid && !p.socket.destroyed && p.guildJoined && !p.inSquad && !this.isPaused(p.uid),
        );
        if (pendingMembers.length === 0) break;

        for (const m of pendingMembers) {
          if (rt.modeRevision !== coordRev) return;
          if (m.inSquad || m.socket.destroyed || !rt.teamGroupId) continue;
          if (!leader.socket.destroyed) {
            leader.socket.write(this.buildInviteTeamPacket(leader.cred, m.uid));
          }
          await sleep(450);
          if (rt.modeRevision !== coordRev) return;
          if (!m.inSquad && !m.socket.destroyed && rt.teamGroupId) {
            this.updateStatus(m.uid, 'SQUAD JOINING', 0);
            this.log(
              `[${squadLabel}] ${m.cred.nickname} joining group via Team Code ${rt.teamCode || rt.teamGroupId}`,
              'info',
            );
            m.inviteAcceptedAt = Date.now();
            m.socket.write(this.buildAcceptTeamInvitePacket(m.cred, leader.uid, rt.teamGroupId));
            await sleep(600);
          }
        }

        if (!leader.socket.destroyed) {
          leader.socket.write(this.buildTeamFreshPacket(leader.cred));
        }
        await sleep(1500);
      }

      if (rt.modeRevision !== coordRev) return;

      // 4. Confirm ALL expected bots are server-confirmed inside this squad before starting match
      const squadMembers = Array.from(rt.peers.values()).filter(
        (p) => !p.socket.destroyed && !this.isPaused(p.uid) && p.guildJoined && p.inSquad,
      );

      if (squadMembers.length < expected || squadMembers.length < 2) {
        this.log(
          `[${squadLabel}] Waiting for full squad (${squadMembers.length}/${expected} in group ${rt.teamCode || ''}) before match start...`,
          'warning',
        );
        setTimeout(() => void this.runSquadCoordinator(squadKey), 3000);
        return;
      }

      // 5. Ready all bots & send ONE Start Match trigger ONLY after full roster is in group
      const alreadyInMatch = squadMembers.some((p) => this.accounts.get(p.uid)?.status === 'IN_MATCH');
      if (!alreadyInMatch && !rt.matchSearching) {
        await this.triggerSquadStartMatch(rt, squadLabel, expected);
      }

      // 6. Persistent Squad & Match Watchdog (NEVER dissolves group unnecessarily or starts solo match!)
      this.clearSquadLoop(rt);
      rt.loopTimer = setInterval(() => {
        if (rt.modeRevision !== coordRev || !this.isGuildActiveForBot(rt.clanId) || !this.isSquadActive(squadKey)) {
          this.clearSquadLoop(rt);
          rt.matchSearching = false;
          return;
        }
        const activeLeader = rt.leaderUid ? rt.peers.get(rt.leaderUid) : undefined;
        const activeExpected = this.getExpectedSquadCount(squadKey, rt.clanId);
        const activePeers = Array.from(rt.peers.values())
          .filter((p) => !p.socket.destroyed && !this.isPaused(p.uid) && p.guildJoined)
          .slice(0, activeExpected);
        const activeSquad = activePeers.filter((p) => p.inSquad);
        const missingFromGroup = activePeers.filter((p) => !p.inSquad);

        const anyInMatch = Array.from(rt.peers.values()).some((p) => this.accounts.get(p.uid)?.status === 'IN_MATCH');
        if (anyInMatch) {
          return;
        }

        // Recover if leader dropped or group ID was cleared while peers are ready
        if (!activeLeader || activeLeader.socket.destroyed || !rt.teamCreated || !rt.teamGroupId) {
          if (activePeers.length >= Math.max(2, activeExpected)) {
            rt.teamCreated = false;
            rt.teamGroupId = null;
            rt.matchSearching = false;
            rt.searchStartedAt = 0;
            this.clearSquadLoop(rt);
            void this.runSquadCoordinator(squadKey);
          }
          return;
        }

        // If any bot is not confirmed inside the Free Fire squad yet, NEVER start a partial match!
        if (missingFromGroup.length > 0 || activeSquad.length < Math.max(2, activeExpected)) {
          if (rt.matchSearching) {
            rt.matchSearching = false;
            rt.searchStartedAt = 0;
            for (const p of activeSquad) {
              if (this.accounts.get(p.uid)?.status === 'SEARCHING') {
                this.updateStatus(p.uid, 'SQUAD JOINED', 0);
              }
            }
          }
          if (
            missingFromGroup.length > 0 &&
            rt.teamCreated &&
            rt.teamGroupId &&
            activeLeader &&
            !activeLeader.socket.destroyed &&
            Date.now() - rt.lastRecoveryAt >= 5000
          ) {
            rt.lastRecoveryAt = Date.now();
            void (async () => {
              for (const m of missingFromGroup) {
                if (m.inSquad || m.socket.destroyed || activeLeader.socket.destroyed || !rt.teamGroupId) continue;
                try {
                  this.updateStatus(m.uid, 'SQUAD JOINING', 0);
                  activeLeader.socket.write(this.buildInviteTeamPacket(activeLeader.cred, m.uid));
                  await sleep(400);
                  if (!m.inSquad && !m.socket.destroyed && rt.teamGroupId) {
                    m.inviteAcceptedAt = Date.now();
                    m.socket.write(this.buildAcceptTeamInvitePacket(m.cred, activeLeader.uid, rt.teamGroupId));
                  }
                  await sleep(400);
                } catch {
                  // ignore
                }
              }
              this.requestLeaderTeamFresh(rt);
            })();
          }
          return;
        }

        // Respect configurable post-match lobby wait delay before next Ready + Start Match
        const lobbyDelayMs = this.getSquadLobbyDelayMs(squadKey);
        if (rt.lastMatchEndedAt > 0 && Date.now() - rt.lastMatchEndedAt < lobbyDelayMs) {
          return;
        }

        // Full roster confirmed in squad -> if not searching yet, Ready + Start Match
        if (!rt.matchSearching) {
          void this.triggerSquadStartMatch(rt, squadLabel, activeExpected);
          return;
        }

        const currentMode = this.getSquadMode(squadKey);
        const elapsedMs = rt.searchStartedAt > 0 ? Date.now() - rt.searchStartedAt : 0;

        if (currentMode === 'CS_RANK') {
          if (elapsedMs >= 20_000 && rt.searchRetries >= 1) {
            this.log(
              `[${squadLabel}] CS Rank queue stalled (${Math.round(elapsedMs / 1000)}s) — switching CS Rank profile & rebuilding squad!`,
              'warning',
            );
            this.rebuildSquadSession(squadKey, 'CS Rank stall profile switch', true);
            return;
          }
          if (elapsedMs >= 16_000 && rt.searchRetries === 0) {
            rt.searchRetries += 1;
            rt.matchSearching = false;
            rt.searchStartedAt = 0;
            this.log(
              `[${squadLabel}] CS Rank queue refreshing (16s) — syncing squad (${activeSquad.length}/${activeExpected}) & re-sending Start Match!`,
              'info',
            );
            this.requestLeaderTeamFresh(rt);
            setTimeout(() => {
              if (rt.modeRevision === coordRev) {
                void this.triggerSquadStartMatch(rt, squadLabel, activeExpected);
              }
            }, 900);
          }
        } else if (elapsedMs >= 65_000) {
          rt.matchSearching = false;
          rt.searchStartedAt = 0;
          if (rt.searchRetries >= 1) {
            this.log(`[${squadLabel}] BR Rank stalled 2x — rebuilding clean squad session!`, 'warning');
            this.rebuildSquadSession(squadKey, 'BR Rank stall', false);
            return;
          }
          rt.searchRetries += 1;
          this.log(
            `[${squadLabel}] BR Rank matchmaking stalled 65s — verifying squad (${activeSquad.length}/${activeExpected}) & retrying queue!`,
            'info',
          );
          this.requestLeaderTeamFresh(rt);
          setTimeout(() => {
            if (rt.modeRevision === coordRev) {
              void this.triggerSquadStartMatch(rt, squadLabel, activeExpected);
            }
          }, 900);
        }
      }, 4000);
    } finally {
      rt.coordinatorRunning = false;
    }
  }

  private extractTcpFrames(rxBuf: Buffer): { frames: { cmdHex: string; payload: Buffer }[]; rest: Buffer } {
    const frames: { cmdHex: string; payload: Buffer }[] = [];
    let offset = 0;

    while (offset < rxBuf.length) {
      if (rxBuf.length - offset < 2) break;

      const b0 = rxBuf[offset];
      const b1 = rxBuf[offset + 1];
      // 2-byte keepalive acks (`0219` BD / `0214` IND / `0215` other)
      if (b0 === 0x02 && (b1 === 0x19 || b1 === 0x14 || b1 === 0x15)) {
        frames.push({ cmdHex: rxBuf.subarray(offset, offset + 2).toString('hex'), payload: Buffer.alloc(0) });
        offset += 2;
        continue;
      }

      if (rxBuf.length - offset < 5) break;

      const cmdHex = rxBuf.subarray(offset, offset + 2).toString('hex');
      const payloadLen = (rxBuf[offset + 2] << 16) | (rxBuf[offset + 3] << 8) | rxBuf[offset + 4];

      if (payloadLen < 0 || payloadLen > 65536) {
        // Resync on next known packet header if stream framing ever shifted
        const next05 = rxBuf.indexOf(Buffer.from([0x05, 0x00]), offset + 1);
        const next03 = rxBuf.indexOf(Buffer.from([0x03, 0x00]), offset + 1);
        const next06 = rxBuf.indexOf(Buffer.from([0x06, 0x00]), offset + 1);
        const candidates = [next05, next03, next06].filter((idx) => idx > offset);
        if (candidates.length === 0) {
          return { frames, rest: Buffer.alloc(0) };
        }
        offset = Math.min(...candidates);
        continue;
      }

      if (rxBuf.length - offset < 5 + payloadLen) break;

      const payload = rxBuf.subarray(offset + 5, offset + 5 + payloadLen);
      frames.push({ cmdHex, payload });
      offset += 5 + payloadLen;
    }

    const rest = offset < rxBuf.length ? Buffer.from(rxBuf.subarray(offset)) : Buffer.alloc(0);
    return { frames, rest: rest.length > 131072 ? Buffer.alloc(0) : rest };
  }

  private connectTcpSocket(
    addrs: string,
    packet: Buffer,
    cred: AccountCredentials,
    ctrl: WorkerControl,
    kind: 'MAIN' | 'INFO',
    guildReady = false,
    actualGuildJoined = false,
  ): void {
    if (!addrs || !addrs.includes(':')) {
      ctrl.mainClosed = kind === 'MAIN';
      return;
    }
    const [host, portStr] = addrs.split(':');
    const port = Number(portStr);
    if (!host || !Number.isFinite(port)) return;

    const sock = net.createConnection({ host, port });
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 10_000);
    ctrl.sockets.add(sock);

    const squadKey = this.getSquadKey(cred.clan_id, cred.squad_id);
    const rt = this.getOrCreateSquadRuntime(squadKey, cred.clan_id || '');
    let kaTimer: ReturnType<typeof setInterval> | null = null;
    const keepAliveBuf = Buffer.from('0219', 'hex');
    let rxBuf: Buffer = Buffer.alloc(0);

    sock.on('connect', () => {
      if (ctrl.cancelled || this.isPaused(cred.account_id)) {
        sock.destroy();
        return;
      }
      sock.write(packet);
      sock.write(keepAliveBuf);
      if (kind === 'MAIN') {
        ctrl.mainClosed = false;
        const hasClan = Boolean(cred.clan_id && /^\d+$/.test(cred.clan_id));
        const isSquadReady = guildReady || !hasClan;
        const acc = this.accounts.get(cred.account_id);
        if (acc && hasClan) {
          acc.guild_joined = actualGuildJoined || Boolean(acc.guild_joined);
        }
        const peer: PeerEntry = {
          uid: cred.account_id,
          squadKey,
          socket: sock,
          cred,
          ctrl,
          guildJoined: isSquadReady,
          inSquad: false,
          readyAt: Date.now() + 850,
          inviteAcceptedAt: 0,
          lastInviteReceivedAt: 0,
        };
        rt.peers.set(cred.account_id, peer);
        this.updateStatus(cred.account_id, actualGuildJoined ? 'GUILD JOINED' : 'ONLINE', 0);
        if (!rt.leaderUid && isSquadReady) rt.leaderUid = cred.account_id;
        this.log(`TCP MAIN connected | ${cred.nickname} (${cred.account_id}) [Squad ${squadKey}]`, 'info');
        if (isSquadReady) {
          setTimeout(() => {
            if (!ctrl.cancelled && !sock.destroyed) {
              void this.runSquadCoordinator(squadKey);
            }
          }, 900);
        }
      } else {
        this.log(`TCP INFO connected | ${cred.account_id}`, 'info');
      }

      kaTimer = setInterval(() => {
        if (ctrl.cancelled || sock.destroyed || this.isPaused(cred.account_id)) return;
        try {
          sock.write(keepAliveBuf);
        } catch {
          // ignore
        }
      }, 5000);
    });

    sock.on('data', (chunk: Buffer) => {
      if (kind !== 'MAIN' || ctrl.cancelled) return;
      rxBuf = Buffer.concat([rxBuf, chunk]);
      const { frames, rest } = this.extractTcpFrames(rxBuf);
      rxBuf = rest;

      const squadCfg = this.loadSquadsDb().find((s) => s.id === squadKey);
      const squadLabel = squadCfg?.name || squadKey;

      for (const frame of frames) {
        if (frame.cmdHex === '0500' && frame.payload.length > 5) {
          try {
            const dec = decodeProtobuf2(frame.payload);
            const prims = extractProtoPrimitives(frame.payload);
            const pktType = Number(dec[4] || 0);
            const f5 = dec[5] && typeof dec[5] === 'object' ? (dec[5] as DecodedDict) : dec;

            const identity = extractTeamIdentity(dec, prims.strings, prims.numbers);
            if (identity.teamCode && rt.teamCode !== identity.teamCode) {
              rt.teamCode = identity.teamCode;
              this.log(`[${squadLabel}] TEAM Code: ${identity.teamCode}`, 'success');
            }
            if (identity.groupId && rt.teamGroupId !== identity.groupId) {
              rt.teamGroupId = identity.groupId;
              if (pktType === 1) rt.teamCreated = true;
            }

            for (const fk of [11, 5, 1, 3]) {
              const v = f5[fk];
              if (v !== undefined && /^\d{7}$/.test(String(v))) {
                const tc = String(v);
                if (rt.teamCode !== tc) {
                  rt.teamCode = tc;
                  this.log(`[${squadLabel}] TEAM Code: ${tc}`, 'success');
                }
                break;
              }
            }

            let frameGroupId = '';
            for (const fk of [14, 8, 10]) {
              const gv = f5[fk];
              if (typeof gv === 'string' && gv.length >= 20 && gv.length <= 48) {
                frameGroupId = gv;
                rt.teamGroupId = gv;
                if (pktType === 1) rt.teamCreated = true;
                break;
              }
            }
            if (!frameGroupId) {
              for (const s of prims.strings) {
                if (/^[0-9a-fA-F-]{20,48}$/.test(s)) {
                  frameGroupId = s;
                  rt.teamGroupId = s;
                  if (pktType === 1) rt.teamCreated = true;
                  break;
                }
              }
            }

            const peer = rt.peers.get(cred.account_id);

            // Packet type 1: authoritative Team/Squad roster snapshot (CreateTeam / TeamFresh response)
            if (pktType === 1 && peer) {
              if (cred.account_id === rt.leaderUid) {
                const isAuthoritativeRoster = prims.numbers.has(cred.account_id) || Boolean(frameGroupId);
                if (isAuthoritativeRoster) {
                  peer.inSquad = true;
                  for (const other of rt.peers.values()) {
                    if (other.uid === cred.account_id) continue;
                    if (prims.numbers.has(other.uid)) {
                      if (!other.inSquad) {
                        other.inSquad = true;
                        if (!rt.matchSearching && this.accounts.get(other.uid)?.status !== 'IN_MATCH') {
                          this.updateStatus(other.uid, 'SQUAD JOINED', 0);
                        }
                        this.log(
                          `SQUAD JOINED | ${other.cred.nickname} (Team Code ${rt.teamCode || 'N/A'})`,
                          'success',
                        );
                      }
                    } else if (other.inSquad) {
                      other.inSquad = false;
                      rt.matchSearching = false;
                      rt.searchStartedAt = 0;
                      if (this.accounts.get(other.uid)?.status !== 'IN_MATCH') {
                        this.updateStatus(other.uid, other.guildJoined ? 'GUILD JOINED' : 'ONLINE', 0);
                      }
                      this.log(
                        `[${squadLabel}] ${other.cred.nickname} absent from squad roster — re-inviting into group`,
                        'warning',
                      );
                    }
                  }
                }
              } else if (
                prims.numbers.has(cred.account_id) &&
                (!rt.leaderUid || prims.numbers.has(rt.leaderUid) || Boolean(frameGroupId))
              ) {
                if (!peer.inSquad) {
                  peer.inSquad = true;
                  if (!rt.matchSearching && this.accounts.get(cred.account_id)?.status !== 'IN_MATCH') {
                    this.updateStatus(cred.account_id, 'SQUAD JOINED', 0);
                  }
                  this.log(`SQUAD JOINED | ${cred.nickname} (Team Code ${rt.teamCode || 'N/A'})`, 'success');
                }
              }
            }

            // Packet type 3: Invite received on member socket -> auto-accept & ask leader to sync roster
            if (pktType === 3 && peer && peer.guildJoined && !peer.inSquad && cred.account_id !== rt.leaderUid) {
              let inviter = '';
              for (const fk of [1, 2, 3, 4, 6, 7, 13, 15, 20]) {
                const cand = f5[fk];
                if (cand !== undefined && /^\d{6,15}$/.test(String(cand)) && String(cand) !== cred.account_id) {
                  inviter = String(cand);
                  break;
                }
              }
              if (!inviter && rt.leaderUid && prims.numbers.has(rt.leaderUid)) {
                inviter = rt.leaderUid;
              }
              if (!inviter) inviter = rt.leaderUid || '';

              const gid = frameGroupId || (typeof f5[8] === 'string' ? f5[8] : rt.teamGroupId || '');
              if (inviter && gid && inviter !== cred.account_id) {
                peer.lastInviteReceivedAt = Date.now();
                peer.inviteAcceptedAt = Date.now();
                this.updateStatus(cred.account_id, 'SQUAD JOINING', 0);
                this.log(
                  `TEAM Invite from ${inviter} -> joining via Team Code ${rt.teamCode || 'Group'}`,
                  'info',
                );
                sock.write(this.buildAcceptTeamInvitePacket(cred, inviter, gid));
                setTimeout(() => this.requestLeaderTeamFresh(rt), 750);
              }
            }

            // Packet type 6 or 16: Team join / update notification -> verify roster via TeamFresh
            if ((pktType === 6 || pktType === 16) && peer) {
              if (rt.teamGroupId && rt.teamCreated) {
                setTimeout(() => this.requestLeaderTeamFresh(rt), 500);
              }
              if (frameGroupId && prims.numbers.has(cred.account_id)) {
                for (const memberPeer of rt.peers.values()) {
                  if (memberPeer.guildJoined && prims.numbers.has(memberPeer.uid) && !memberPeer.inSquad) {
                    memberPeer.inSquad = true;
                    if (!rt.matchSearching && this.accounts.get(memberPeer.uid)?.status !== 'IN_MATCH') {
                      this.updateStatus(memberPeer.uid, 'SQUAD JOINED', 0);
                    }
                    this.log(
                      `SQUAD JOINED | ${memberPeer.cred.nickname} (Team Code ${rt.teamCode || 'N/A'})`,
                      'success',
                    );
                  }
                }
              }
            }

            // Packet type 5, 7, 8: Member leave / kick / decline -> keep group intact, clear search, resync roster
            if (pktType === 5 || pktType === 7 || pktType === 8) {
              rt.matchSearching = false;
              rt.searchStartedAt = 0;
              if (peer && cred.account_id !== rt.leaderUid && prims.numbers.has(cred.account_id)) {
                peer.inSquad = false;
                if (this.accounts.get(cred.account_id)?.status !== 'IN_MATCH') {
                  this.updateStatus(cred.account_id, peer.guildJoined ? 'GUILD JOINED' : 'ONLINE', 0);
                }
              }
              this.log(
                `[${squadLabel}] Team update (type ${pktType}) — checking squad roster & keeping group intact`,
                'warning',
              );
              setTimeout(() => this.requestLeaderTeamFresh(rt), 450);
            }

            // Packet type 9, 10, or unhandled rejection/error packet while searching -> decode & recover immediately
            const isUnhandledSearchingPkt =
              rt.matchSearching && ![1, 2, 3, 4, 5, 6, 7, 8, 16].includes(pktType);
            if (pktType === 9 || pktType === 10 || isUnhandledSearchingPkt) {
              const reasonHint = this.decodeClanErrorSnippet(frame.payload);
              const wasSearching = rt.matchSearching;
              rt.matchSearching = false;
              rt.searchStartedAt = 0;
              for (const p of rt.peers.values()) {
                if (this.accounts.get(p.uid)?.status === 'SEARCHING') {
                  this.updateStatus(p.uid, p.inSquad ? 'SQUAD JOINED' : 'GUILD JOINED', 0);
                }
              }
              if (wasSearching || cred.account_id === rt.leaderUid) {
                const sqMode = this.getSquadMode(squadKey);
                this.log(
                  `[${squadLabel}] Matchmaking response (pktType=${pktType}${reasonHint ? `: ${reasonHint}` : ''}) — recovering ${sqMode} queue...`,
                  'warning',
                );
                if (sqMode === 'CS_RANK' && (pktType >= 11 || /ERR|FAIL|LIMIT|LV|LEVEL|RANK|LOCK|MODE/i.test(reasonHint))) {
                  this.rebuildSquadSession(squadKey, `CS Rank response pktType=${pktType}`, true);
                } else {
                  this.requestLeaderTeamFresh(rt);
                  setTimeout(() => {
                    if (!ctrl.cancelled && this.isGuildActiveForBot(rt.clanId) && this.isSquadActive(squadKey)) {
                      const exp = this.getExpectedSquadCount(squadKey, rt.clanId);
                      void this.triggerSquadStartMatch(rt, squadLabel, exp);
                    }
                  }, 1200);
                }
              }
            }
          } catch {
            // ignore
          }
        }

        if (frame.cmdHex === '0300' && frame.payload.length < 295 && rt.matchSearching) {
          const hint = this.decodeClanErrorSnippet(frame.payload);
          rt.matchSearching = false;
          rt.searchStartedAt = 0;
          const sqMode = this.getSquadMode(squadKey);
          this.log(
            `[${squadLabel}] Short 0300 matchmaking response (${frame.payload.length}B${hint ? `: ${hint}` : ''}) — retrying ${sqMode}...`,
            'warning',
          );
          for (const p of rt.peers.values()) {
            if (this.accounts.get(p.uid)?.status === 'SEARCHING') {
              this.updateStatus(p.uid, p.inSquad ? 'SQUAD JOINED' : 'GUILD JOINED', 0);
            }
          }
          if (sqMode === 'CS_RANK') {
            this.rebuildSquadSession(squadKey, 'CS Rank 0300 rejection', true);
          } else {
            setTimeout(() => {
              if (!ctrl.cancelled && this.isGuildActiveForBot(rt.clanId) && this.isSquadActive(squadKey)) {
                const exp = this.getExpectedSquadCount(squadKey, rt.clanId);
                void this.triggerSquadStartMatch(rt, squadLabel, exp);
              }
            }, 1200);
          }
        }

        if (frame.cmdHex === '0300' && frame.payload.length >= 295) {
          this.matchesStarted += 1;
          rt.matchStartedAt = Date.now();
          rt.matchSearching = false;
          rt.searchStartedAt = 0;
          rt.searchRetries = 0;

          const acc = this.accounts.get(cred.account_id);
          if (acc) {
            acc.matches += 1;
            acc.matches_played = acc.matches;
            acc.last_match_time = nowTime();
          }
          this.updateStatus(cred.account_id, 'IN_MATCH', 1);
          this.log(`Match Found | UID: ${cred.account_id} (${cred.nickname})`, 'success');

          try {
            const res = decodeProtobuf2(frame.payload);
            const rf5 = res[5] && typeof res[5] === 'object' ? (res[5] as DecodedDict) : null;
            const serverIpPort = rf5 && typeof rf5[2] === 'string' ? rf5[2] : '';
            const rawUdpKey = rf5 && typeof rf5[3] === 'string' ? rf5[3] : '';
            const udpKeyHex = /^[0-9a-fA-F]{32}$/.test(rawUdpKey)
              ? rawUdpKey
              : Buffer.from(rawUdpKey, 'utf8').length === 16
              ? Buffer.from(rawUdpKey, 'utf8').toString('hex')
              : '';
            const matchToken = rf5 && typeof rf5[4] === 'string' ? rf5[4] : '';
            const matchCodeRaw = (rf5 && rf5[42] !== undefined ? rf5[42] : res[42]) ?? '';
            const matchCode = String(matchCodeRaw).trim();
            const blockVal = Number(rf5?.[1] || 0);
            const effectiveAccId = String(res[1] || cred.account_id);

            if (serverIpPort && udpKeyHex && matchToken && matchCode) {
              const sqMode = this.getSquadMode(squadKey);
              const sqCfg = this.loadSquadsDb().find((s) => s.id === squadKey);
              const modeSpec = getModeSpec(sqMode, sqCfg?.target_size || 4, rt.modeProfileIdx);
              const handle = startUdpMatchSession({
                serverIpPort,
                token: matchToken,
                udpKeyHex,
                matchCode,
                accountId: effectiveAccId,
                blockVal,
                region: cred.region || 'BD',
                clientVersion: cred.client_version || '1.132.9',
                accessToken: cred.access_token || '',
                modeId: modeSpec.udpModeId,
                mapId: modeSpec.udpMapId,
                isStopped: () => ctrl.cancelled || this.isPaused(cred.account_id),
                onPlaying: () => {
                  this.log(`Playing In-Match [${modeSpec.label}] (UDP Live) | ${cred.nickname} -> ${serverIpPort}`, 'success');
                },
                onLog: (m, lvl) => this.log(m, lvl),
                onFinished: (matchFinishReason) => {
                  const completedCleanly = isCleanUdpMatchFinish(matchFinishReason);
                  ctrl.udpHandles.delete(handle);
                  if (completedCleanly) {
                    this.totalMatches += 1;
                    this.log(`Match Complete | UID: ${cred.account_id} (${cred.nickname})`, 'success');
                    setTimeout(() => void this.refreshAccountProfile(cred), 3000);
                    setTimeout(() => void this.refreshAccountProfile(cred), 8500);
                  }
                  const peerNow = rt.peers.get(cred.account_id);
                          this.updateStatus(
                            cred.account_id,
                            this.isPaused(cred.account_id)
                              ? 'PAUSED'
                              : peerNow?.inSquad
                              ? 'SQUAD JOINED'
                              : peerNow?.guildJoined
                              ? 'GUILD JOINED'
                              : 'ONLINE',
                            0,
                          );
                  // Once all squad peers finish match, hold in lobby for configurable lobby_delay_sec before next match
                  const stillPlaying = Array.from(rt.peers.values()).some(
                    (p) => this.accounts.get(p.uid)?.status === 'IN_MATCH',
                  );
                  if (
                    !stillPlaying &&
                            (rt.lastMatchEndedAt === 0 || !completedCleanly) &&
                    !ctrl.cancelled &&
                    !this.isPaused(cred.account_id)
                  ) {
                    rt.matchStartedAt = 0;
                    rt.matchSearching = false;
                    rt.searchRetries = 0;
                    rt.lastMatchEndedAt = Date.now();
                    const delayMs = this.getSquadLobbyDelayMs(squadKey);
                            if (!completedCleanly) {
                              this.log(
                                `[${squadLabel}] Match interrupted (${matchFinishReason}) — restoring lobby and reconnecting squad`,
                                'warning',
                              );
                              setTimeout(() => {
                                this.requestLeaderTeamFresh(rt);
                                void this.runSquadCoordinator(squadKey);
                              }, Math.max(1500, delayMs));
                              return;
                            }
                    const squads = this.loadSquadsDb();
                    const squadConfig = squads.find((s) => s.id === squadKey);
                    const completedMatches = (squadConfig?.completed_matches_in_cycle || 0) + 1;
                    const resetCycle = shouldResetSquadMatchCycle(completedMatches);
                    if (squadConfig) {
                      squadConfig.completed_matches_in_cycle = resetCycle ? 0 : completedMatches;
                      this.saveSquadsDb(squads);
                    }
                    this.log(
                      `[${squadLabel}] Returned to lobby — waiting ${Math.round(delayMs / 1000)}s before next match`,
                      'info',
                    );
                    if (resetCycle) {
                      this.log(
                        `[${squadLabel}] Completed ${MATCH_CYCLE_RESET_AFTER} matches — resetting the squad after the lobby wait`,
                        'success',
                      );
                    }
                    setTimeout(() => {
                      if (resetCycle) {
                        if (!this.restartSquad(squadKey)) {
                          this.log(`[${squadLabel}] Automatic match-cycle reset could not restart the squad`, 'error');
                        }
                        return;
                      }
                      this.requestLeaderTeamFresh(rt);
                      void this.runSquadCoordinator(squadKey);
                    }, Math.max(1500, delayMs));
                  }
                },
              });
              ctrl.udpHandles.add(handle);
            }
          } catch (err) {
            this.log(`UDP Match start parse warn (${cred.account_id}): ${(err as Error).message}`, 'warning');
          }
        }
      }
    });

    sock.on('error', () => {
      // handled in close
    });

    sock.on('close', () => {
      if (kaTimer) clearInterval(kaTimer);
      ctrl.sockets.delete(sock);
      if (kind === 'MAIN') {
        ctrl.mainClosed = true;
        const isCurrentWorker =
          this.workers.get(cred.account_id) === ctrl ||
          (cred.auth_uid ? this.workers.get(cred.auth_uid) === ctrl : false);
        const curPeer = rt.peers.get(cred.account_id);
        const isCurrentPeer = curPeer?.socket === sock;
        if (isCurrentPeer) {
          rt.peers.delete(cred.account_id);
          rt.matchSearching = false;
          rt.searchStartedAt = 0;
          if (rt.peers.size === 0) {
            rt.leaderUid = null;
            rt.teamCode = null;
            rt.teamGroupId = null;
            rt.teamCreated = false;
            this.clearSquadLoop(rt);
          } else if (rt.leaderUid === cred.account_id) {
            const nextPeer =
              Array.from(rt.peers.values()).find((p) => p.guildJoined && p.inSquad) ||
              Array.from(rt.peers.values()).find((p) => p.guildJoined) ||
              null;
            rt.leaderUid = nextPeer ? nextPeer.uid : null;
            if (nextPeer) this.requestLeaderTeamFresh(rt);
          }
        }
        if (isCurrentWorker && !ctrl.cancelled && !this.isPaused(cred.account_id)) {
          this.updateStatus(cred.account_id, 'CONNECTING', 0);
          rt.matchSearching = false;
          rt.searchStartedAt = 0;
          rt.lastMatchEndedAt = 0;
          setTimeout(() => {
            if (!ctrl.cancelled && !this.isPaused(cred.account_id) && this.isGuildActiveForBot(rt.clanId) && this.isSquadActive(squadKey)) {
              void this.runSquadCoordinator(squadKey);
            }
          }, 1200);
        }
      }
    });
  }

  startGuestWorker(row: SavedAccountRow): void {
    const uid = String(row.uid).trim();
    const existing = this.workers.get(uid);
    if (existing) {
      existing.cancelled = true;
      for (const u of existing.udpHandles) {
        try {
          u.stop();
        } catch {
          // ignore
        }
      }
      for (const s of existing.sockets) {
        try {
          s.destroy();
        } catch {
          // ignore
        }
      }
      for (const t of existing.timers) clearTimeout(t);
    }

    const ctrl: WorkerControl = {
      cancelled: false,
      loginFailureCount: 0,
      sockets: new Set(),
      timers: new Set(),
      udpHandles: new Set(),
      mainClosed: false,
    };
    this.workers.set(uid, ctrl);

    if (!this.resolveAccountKey(uid)) {
      this.registerAccount(uid, `Bot_${uid.slice(-4)}`, 'BD', 1, 0, 0, uid, {
        clan_id: row.clan_id,
        squad_id: row.squad_id || null,
        max_matches: row.max_matches || 0,
        max_hours: row.max_hours || 0,
      });
      this.updateStatus(uid, 'CONNECTING', 0);
    }

    const skey = this.getSquadKey(row.clan_id, row.squad_id);

    (async () => {
      while (!ctrl.cancelled) {
        if (this.isPaused(uid) || !this.isGuildActiveForBot(row.clan_id) || !this.isSquadActive(skey)) {
          await sleep(1500, ctrl);
          continue;
        }
        try {
          this.updateStatus(uid, 'CONNECTING', 0);
          const cred = await this.processGuestLogin(uid, row.password, {
            clan_id: row.clan_id,
            squad_id: row.squad_id || skey,
            max_matches: row.max_matches || 0,
            max_hours: row.max_hours || 0,
          });
          if (!cred) {
            const curStatus = this.accounts.get(this.resolveAccountKey(uid) || uid)?.status;
            if (curStatus === 'BANNED') {
              this.log(`Login rejected for ${uid}; account retained and retrying after cooldown`, 'warning');
              await sleep(5 * 60_000, ctrl);
            } else {
              ctrl.loginFailureCount = (ctrl.loginFailureCount || 0) + 1;
              this.updateStatus(uid, 'CONNECTING', 0);
              const delayMs = getReconnectDelayMs(ctrl.loginFailureCount);
              this.log(`Login unavailable for ${uid}; account retained, retrying in ${Math.round(delayMs / 1000)}s`, 'warning');
              await sleep(delayMs, ctrl);
            }
            continue;
          }
          if (ctrl.cancelled) break;

          ctrl.loginFailureCount = 0;
          this.workers.set(cred.account_id, ctrl);

          let guildReady = true;
          let actualGuildJoined = true;
          if (row.clan_id && /^\d+$/.test(row.clan_id)) {
            const gRes = await this.ensureGuildJoined(cred, row.clan_id, ctrl);
            guildReady = gRes.proceed;
            actualGuildJoined = gRes.joined;
            if (!guildReady || ctrl.cancelled) {
              await sleep(2000, ctrl);
              continue;
            }
          }

          if (!cred.functional_addrs) {
            this.invalidateCache(row.uid);
            this.invalidateCache(cred.account_id);
            this.updateStatus(uid, 'CONNECTING', 0);
            await sleep(5000, ctrl);
            continue;
          }

          ctrl.mainClosed = false;
          if (cred.functional_addrs) {
            this.connectTcpSocket(
              cred.functional_addrs,
              this.buildTcpStartupPacket(cred, 'OnLine'),
              cred,
              ctrl,
              'MAIN',
              guildReady,
              actualGuildJoined,
            );
          }
          if (cred.informational_addrs) {
            this.connectTcpSocket(
              cred.informational_addrs,
              this.buildTcpStartupPacket(cred, 'ChaT'),
              cred,
              ctrl,
              'INFO',
              guildReady,
              actualGuildJoined,
            );
          }

          let lastRefreshAt = Date.now();
          while (!ctrl.cancelled && !ctrl.mainClosed) {
            await sleep(2000, ctrl);
            if (ctrl.cancelled || ctrl.mainClosed) break;
            if (Date.now() - lastRefreshAt >= 45_000) {
              lastRefreshAt = Date.now();
              if (!this.isPaused(cred.account_id) && this.isGuildActiveForBot(row.clan_id) && this.isSquadActive(skey)) {
                await this.refreshAccountProfile(cred);
              }
            }
          }
          if (!ctrl.cancelled && ctrl.mainClosed) {
            if (ctrl.fastReconnect) {
              ctrl.fastReconnect = false;
              await sleep(450, ctrl);
            } else {
              this.log(`TCP MAIN closed for ${cred.nickname} — auto-reconnecting into squad...`, 'warning');
              await sleep(2200, ctrl);
            }
          }
        } catch (err) {
          this.log(`Worker ${uid} error: ${(err as Error).message}`, 'error');
          await sleep(10_000, ctrl);
        }
      }
    })();
  }

  async addTokenAccount(token: string, clanId: string, squadId?: string): Promise<void> {
    this.log(`TOKEN Login ${token.slice(0, 18)}...`, 'info');
    try {
      const vc = await this.versionConfig('BD');
      if (!vc) return;
      const inspectRes = await httpRequest(
        `https://100067.connect.garena.com/oauth/token/inspect?token=${encodeURIComponent(token)}`,
        {
          headers: { 'User-Agent': 'GarenaMSDK/4.0.19P4(G011A ;Android 9;en;US;)' },
          timeoutMs: 10000,
        },
      );
      if (inspectRes.status !== 200) {
        this.log('Token inspect failed', 'error');
        return;
      }
      const d = JSON.parse(inspectRes.body.toString('utf8')) as { open_id?: string; platform?: number; error?: string };
      if (d.error || !d.open_id) {
        this.log(`Invalid access token: ${d.error || 'no open_id'}`, 'error');
        return;
      }
      const dev = getDeviceForAccount(token.slice(0, 16));
      let { majorPayload, loginPayload } = this.buildLoginPayloads(
        token,
        d.open_id,
        Number(d.platform || 4),
        vc.remoteVersion,
        String(dev.unique_device_id),
      );
      let ml = await this.majorLogin(majorPayload, vc.serverUrl, vc.releaseVersion);
      if (ml && !ml.serverUrl && ml.jwtToken) {
        await this.chooseRegion('BD', ml.jwtToken, vc.serverUrl, vc.releaseVersion);
        await sleep(1500);
        const next = this.buildLoginPayloads(
          token,
          d.open_id,
          Number(d.platform || 4),
          vc.remoteVersion,
          String(dev.unique_device_id),
        );
        loginPayload = next.loginPayload;
        const ml2 = await this.majorLogin(next.majorPayload, vc.serverUrl, vc.releaseVersion);
        if (ml2 && ml2.serverUrl) ml = ml2;
      }
      if (!ml || !ml.serverUrl) {
        this.log('Token MajorLogin failed', 'error');
        return;
      }
      const ld = await this.getLoginData(loginPayload, ml.jwtToken, ml.serverUrl, vc.releaseVersion);
      if (!ld) return;
      const level = Number(ld[6] || 1);
      const exp = Number(ld[7] || 0);
      const likes = Number(ld[8] || 0);
      const nickname = typeof ld[4] === 'string' && ld[4] ? ld[4] : `Player_${ml.accountId}`;
      const skey = this.getSquadKey(clanId, squadId);
      const cred: AccountCredentials = {
        account_id: ml.accountId,
        nickname,
        region: 'BD',
        level,
        exp,
        likes,
        open_id: d.open_id,
        access_token: token,
        platform: String(d.platform || 4),
        token: ml.jwtToken,
        server_time: ml.serverTime,
        aes_ak: ml.aesKey,
        iv_i: ml.aesIv,
        functional_addrs: typeof ld[14] === 'string' ? ld[14] : '',
        informational_addrs: typeof ld[32] === 'string' ? ld[32] : '',
        release_version: vc.releaseVersion,
        client_version: vc.remoteVersion,
        server_url: ml.serverUrl,
        login_payload_data: loginPayload,
        auth_type: 'token',
        auth_token: token,
        clan_id: clanId,
        squad_id: skey,
      };
      this.registerAccount(ml.accountId, nickname, 'BD', level, exp, likes, undefined, {
        clan_id: clanId,
        squad_id: skey,
      });
      this.credentials.set(ml.accountId, cred);
      const ctrl: WorkerControl = {
        cancelled: false,
        sockets: new Set(),
        timers: new Set(),
        udpHandles: new Set(),
        mainClosed: false,
      };
      this.workers.set(ml.accountId, ctrl);
      let guildReady = true;
      let actualGuildJoined = true;
      if (clanId && /^\d+$/.test(clanId)) {
        const gRes = await this.ensureGuildJoined(cred, clanId, ctrl);
        guildReady = gRes.proceed;
        actualGuildJoined = gRes.joined;
        if (!guildReady || ctrl.cancelled) return;
      }
      if (cred.functional_addrs) {
        this.connectTcpSocket(
          cred.functional_addrs,
          this.buildTcpStartupPacket(cred, 'OnLine'),
          cred,
          ctrl,
          'MAIN',
          guildReady,
          actualGuildJoined,
        );
      }
      if (cred.informational_addrs) {
        this.connectTcpSocket(
          cred.informational_addrs,
          this.buildTcpStartupPacket(cred, 'ChaT'),
          cred,
          ctrl,
          'INFO',
          guildReady,
          actualGuildJoined,
        );
      }
    } catch (e) {
      this.log(`Token login error: ${(e as Error).message}`, 'error');
    }
  }

  async createGuild(input: {
    clan_id: string;
    name?: string;
    days?: number;
    hours?: number;
    minutes?: number;
  }): Promise<GuildConfig> {
    const clanId = String(input.clan_id || '').trim();
    const days = Math.max(0, Math.floor(Number(input.days || 0)));
    const hours = Math.max(0, Math.floor(Number(input.hours || 0)));
    const minutes = Math.max(0, Math.floor(Number(input.minutes || 0)));
    const totalMs = ((days * 24 + hours) * 60 + minutes) * 60_000;
    const now = Date.now();
    const expiresAt = totalMs > 0 ? now + totalMs : null;

    const lookup = await this.lookupClanReal(clanId);
    const resolvedName =
      lookup.found && lookup.name
        ? lookup.name
        : String(input.name || '').trim() || `Guild ${clanId}`;

    const guilds = this.loadGuildsDb();
    const existing = guilds.find((g) => g.clan_id === clanId);
    const record: GuildConfig = {
      clan_id: clanId,
      name: resolvedName,
      region: lookup.region || existing?.region || 'BD',
      verified: lookup.found || existing?.verified || false,
      created_at: existing?.created_at || now,
      duration_days: days,
      duration_hours: hours,
      duration_minutes: minutes,
      expires_at: expiresAt,
      is_paused: false,
    };

    const next = guilds.filter((g) => g.clan_id !== clanId);
    next.push(record);
    this.saveGuildsDb(next);
    this.log(
      `Guild saved: "${record.name}" (${clanId}) · ${totalMs > 0 ? `${days}d ${hours}h ${minutes}m` : 'Unlimited'}`,
      'success',
    );
    return record;
  }

  updateGuild(input: {
    clan_id: string;
    name?: string;
    days?: number;
    hours?: number;
    minutes?: number;
    is_paused?: boolean;
  }): GuildConfig | null {
    const clanId = String(input.clan_id || '').trim();
    const guilds = this.loadGuildsDb();
    const g = guilds.find((x) => x.clan_id === clanId);
    if (!g) return null;

    if (typeof input.name === 'string' && input.name.trim()) {
      g.name = input.name.trim();
    }
    if (
      input.days !== undefined ||
      input.hours !== undefined ||
      input.minutes !== undefined
    ) {
      const d = Math.max(0, Math.floor(Number(input.days ?? g.duration_days ?? 0)));
      const h = Math.max(0, Math.floor(Number(input.hours ?? g.duration_hours ?? 0)));
      const m = Math.max(0, Math.floor(Number(input.minutes ?? g.duration_minutes ?? 0)));
      g.duration_days = d;
      g.duration_hours = h;
      g.duration_minutes = m;
      const totalMs = ((d * 24 + h) * 60 + m) * 60_000;
      g.expires_at = totalMs > 0 ? Date.now() + totalMs : null;
    }
    if (typeof input.is_paused === 'boolean') {
      g.is_paused = input.is_paused;
    }

    this.saveGuildsDb(guilds);

    const accs = this.loadAccountsDb().filter((a) => String(a.clan_id) === clanId);
    const shouldPause = g.is_paused || (g.expires_at !== null && Date.now() >= g.expires_at);
    for (const a of accs) {
      if (shouldPause) {
        this.togglePause(String(a.uid), true);
      } else {
        this.togglePause(String(a.uid), false);
        this.startGuestWorker(a);
      }
    }

    this.log(`Guild updated: "${g.name}" (${clanId})`, 'info');
    return g;
  }

  deleteGuild(clanId: string, deleteAccounts = true): void {
    const cid = String(clanId || '').trim();
    this.creationQueue = this.creationQueue.filter((j) => j.clanId !== cid);
    const squads = this.loadSquadsDb();
    const removedSquadIds = new Set(squads.filter((s) => s.clan_id === cid).map((s) => s.id));
    for (const sid of removedSquadIds) {
      this.activeCreationPending.delete(sid);
      const rt = this.squadRuntimes.get(sid);
      if (rt) {
        this.clearSquadLoop(rt);
        this.squadRuntimes.delete(sid);
      }
    }
    this.saveSquadsDb(squads.filter((s) => s.clan_id !== cid));
    this.saveGuildsDb(this.loadGuildsDb().filter((g) => g.clan_id !== cid));

    const db = this.loadAccountsDb();
    if (deleteAccounts) {
      for (const a of db) {
        if (String(a.clan_id) === cid) {
          this.deleteAccount(String(a.uid));
        }
      }
    } else {
      for (const a of db) {
        if (String(a.clan_id) === cid) {
          a.clan_id = '';
          a.squad_id = undefined;
          const acc = this.accounts.get(this.resolveAccountKey(String(a.uid)) || '');
          if (acc) {
            acc.clan_id = '';
            acc.clan_name = undefined;
            acc.guild_joined = false;
            acc.squad_id = null;
          }
        }
      }
      this.saveAccountsDb(db);
    }
    this.log(`Deleted Guild ${cid}`, 'warning');
  }

  private enqueueBotCreation(job: CreationJob): void {
    this.creationQueue.push(job);
    if (!this.creationWorkerRunning) {
      void this.processCreationQueue();
    }
  }

  private async processCreationQueue(): Promise<void> {
    if (this.creationWorkerRunning) return;
    this.creationWorkerRunning = true;
    try {
      while (this.creationQueue.length > 0) {
        const job = this.creationQueue.shift();
        if (!job) break;
        await this.createBotsForSquads(job.clanId, job.chunkSizes, job.squadIds, job.password, job.botPrefix);
        if (this.creationQueue.length > 0) {
          await sleep(1200);
        }
      }
    } finally {
      this.creationWorkerRunning = false;
    }
  }

  async ensureSquadForAdd(clanId: string, squadId?: string, squadName?: string, accountUid?: string): Promise<string> {
    const cid = String(clanId || '').trim() || CLAN_ID_DEFAULT;
    const guilds = this.loadGuildsDb();
    if (!guilds.some((g) => g.clan_id === cid)) {
      await this.createGuild({ clan_id: cid });
    }
    const squads = this.loadSquadsDb();
    const sid = squadId && squadId !== '__new__' ? String(squadId).trim() : '';
    if (sid) {
      const existing = squads.find((s) => s.id === sid && s.clan_id === cid);
      if (existing) {
        const members = this.loadAccountsDb().filter(
          (a) => this.getSquadKey(a.clan_id, a.squad_id) === existing.id,
        );
        const alreadyAssigned = accountUid
          ? members.some((row) => {
              const key = this.resolveAccountKey(String(row.uid));
              const acc = key ? this.accounts.get(key) : undefined;
              return String(row.uid) === accountUid || acc?.uid === accountUid;
            })
          : false;
        const currentMembers = members.length + this.getPendingCreationCount(existing.id);
        if (!alreadyAssigned && getSquadAvailableSlots(currentMembers) === 0) {
          throw new Error('Squad is full (maximum 4 players). Choose another squad or remove a player first.');
        }
        const nextSize = Math.max(2, Math.min(4, Math.max(existing.target_size || 2, currentMembers + 1)));
        if (existing.target_size !== nextSize) {
          existing.target_size = nextSize;
          this.saveSquadsDb(squads);
        }
        return existing.id;
      }
    }

    const guildSquadCount = squads.filter((s) => s.clan_id === cid).length;
    const newId = `sq_${crypto.randomUUID().slice(0, 8)}`;
    const title = String(squadName || '').trim() || `Squad ${guildSquadCount + 1}`;
    const cfg: SquadConfig = {
      id: newId,
      clan_id: cid,
      name: title,
      target_size: 4,
      game_mode: 'BR_RANK',
      lobby_delay_sec: 5,
      bot_prefix: 'RDX',
      is_paused: false,
      created_at: Date.now(),
    };
    squads.push(cfg);
    this.saveSquadsDb(squads);
    return newId;
  }

  async createSquad(input: {
    clan_id: string;
    target_squad_id?: string;
    name?: string;
    target_size?: number;
    game_mode?: string;
    lobby_delay_sec?: number;
    bot_prefix?: string;
    mode?: 'create_bots' | 'assign_existing';
    count?: number;
    password?: string;
    account_uids?: string[];
  }): Promise<{ ok: boolean; squads: SquadConfig[]; error?: string }> {
    const clanId = String(input.clan_id || '').trim();
    if (!clanId) return { ok: false, squads: [], error: 'clan_id required' };

    const guilds = this.loadGuildsDb();
    if (!guilds.some((g) => g.clan_id === clanId)) {
      await this.createGuild({ clan_id: clanId });
    }

    const mode = input.mode || 'create_bots';
    const gameMode = normalizeGameMode(input.game_mode);
    const lobbyDelaySec = Math.max(0, Math.min(120, Math.floor(Number(input.lobby_delay_sec ?? 5))));
    const botPrefix = sanitizeBotPrefix(input.bot_prefix);
    const existingSquads = this.loadSquadsDb();
    const guildSquadCount = existingSquads.filter((s) => s.clan_id === clanId).length;
    const baseName =
      String(input.name || '').trim() ||
      `Squad ${guildSquadCount + 1}`;

    if (mode === 'assign_existing') {
      const uids = Array.isArray(input.account_uids) ? Array.from(new Set(input.account_uids.map(String).filter(Boolean))) : [];
      if (uids.length === 0) return { ok: false, squads: [], error: 'Select at least 1 player' };
      if (uids.length > MAX_SQUAD_SIZE) {
        return { ok: false, squads: [], error: `A squad can have at most ${MAX_SQUAD_SIZE} players` };
      }
      const db = this.loadAccountsDb();
      const targetSet = new Set(uids);
      const selectedRows = db.filter((row) => {
        const key = this.resolveAccountKey(String(row.uid));
        const acc = key ? this.accounts.get(key) : undefined;
        return targetSet.has(String(row.uid)) || Boolean(acc && targetSet.has(acc.uid));
      });
      if (selectedRows.length !== uids.length) {
        return { ok: false, squads: [], error: 'One or more selected accounts were not found' };
      }
      const targetSize = Math.max(2, Math.min(4, Number(input.target_size || uids.length || 4)));
      const squadId = `sq_${crypto.randomUUID().slice(0, 8)}`;
      const cfg: SquadConfig = {
        id: squadId,
        clan_id: clanId,
        name: baseName,
        target_size: targetSize,
        game_mode: gameMode,
        lobby_delay_sec: lobbyDelaySec,
        bot_prefix: botPrefix,
        is_paused: false,
        created_at: Date.now(),
      };
      existingSquads.push(cfg);
      this.saveSquadsDb(existingSquads);

      for (const row of db) {
        const key = this.resolveAccountKey(String(row.uid));
        const acc = key ? this.accounts.get(key) : undefined;
        if (targetSet.has(String(row.uid)) || (acc && targetSet.has(acc.uid))) {
          row.clan_id = clanId;
          row.squad_id = squadId;
          if (acc) {
            acc.clan_id = clanId;
            acc.squad_id = squadId;
            acc.guild_joined = false;
          }
        }
      }
      this.saveAccountsDb(db);
      for (const row of db) {
        const key = this.resolveAccountKey(String(row.uid));
        const acc = key ? this.accounts.get(key) : undefined;
        if (targetSet.has(String(row.uid)) || (acc && targetSet.has(acc.uid))) {
          this.startGuestWorker(row);
        }
      }
      this.log(`Created Squad "${cfg.name}" [${gameMode}] (${uids.length} players) in Guild ${clanId}`, 'success');
      return { ok: true, squads: [cfg] };
    }

    const password = String(input.password || 'RDX771').trim() || 'RDX771';

    // If user targeted an existing squad from Accounts -> Create Team or My Squad -> Add/Replace Bot, keep existing target_size
    const targetSqId = input.target_squad_id ? String(input.target_squad_id).trim() : '';
    if (targetSqId) {
      const existingTarget = existingSquads.find((s) => s.id === targetSqId && s.clan_id === clanId);
      if (existingTarget) {
        const requestedCount = Math.floor(Number(input.count || 1));
        if (!Number.isFinite(requestedCount) || requestedCount < 1) {
          return { ok: false, squads: [], error: 'A valid player count is required' };
        }
        const currentMembers = this.loadAccountsDb().filter(
          (a) => this.getSquadKey(a.clan_id, a.squad_id) === existingTarget.id,
        ).length;
        const availableSlots = getSquadAvailableSlots(
          currentMembers,
          this.getPendingCreationCount(existingTarget.id),
        );
        if (availableSlots === 0) {
          return { ok: false, squads: [], error: 'Squad is full (maximum 4 players)' };
        }
        if (requestedCount > availableSlots) {
          return {
            ok: false,
            squads: [],
            error: `Only ${availableSlots} player slot(s) remain in this squad`,
          };
        }
        const addCount = requestedCount;
        const desiredTargetSize = Math.max(
          2,
          Math.min(4, Math.max(existingTarget.target_size || 2, currentMembers + addCount)),
        );
        const effPrefix = input.bot_prefix ? sanitizeBotPrefix(input.bot_prefix) : sanitizeBotPrefix(existingTarget.bot_prefix);
        existingTarget.target_size = desiredTargetSize;
        existingTarget.bot_prefix = effPrefix;
        if (input.game_mode) existingTarget.game_mode = normalizeGameMode(input.game_mode);
        if (input.lobby_delay_sec !== undefined) {
          existingTarget.lobby_delay_sec = Math.max(0, Math.min(120, Math.floor(Number(input.lobby_delay_sec))));
        }
        this.saveSquadsDb(existingSquads);
        this.enqueueBotCreation({
          clanId,
          chunkSizes: [addCount],
          squadIds: [existingTarget.id],
          password,
          botPrefix: effPrefix,
        });
        return { ok: true, squads: [existingTarget] };
      }
    }

    // Create new bot accounts (auto-split into squads of max 4 if count > 4, e.g. 7 -> 4 + 3)
    const count = Math.max(2, Math.min(12, Number(input.count || input.target_size || 4)));
    const createdSquads: SquadConfig[] = [];
    const chunkSizes: number[] = [];
    let rem = count;
    while (rem > 0) {
      if (rem <= 4) {
        chunkSizes.push(rem);
        break;
      }
      if (rem === 5) {
        chunkSizes.push(3, 2);
        break;
      }
      chunkSizes.push(4);
      rem -= 4;
    }

    const squadsDb = this.loadSquadsDb();
    const squadIds: string[] = [];
    const startNumber = guildSquadCount + 1;
    chunkSizes.forEach((sz, idx) => {
      const sid = `sq_${crypto.randomUUID().slice(0, 8)}`;
      const sqTitle =
        idx === 0 && String(input.name || '').trim()
          ? String(input.name || '').trim()
          : `Squad ${startNumber + idx}`;
      const cfg: SquadConfig = {
        id: sid,
        clan_id: clanId,
        name: sqTitle,
        target_size: Math.max(2, Math.min(4, sz)),
        game_mode: gameMode,
        lobby_delay_sec: lobbyDelaySec,
        bot_prefix: botPrefix,
        is_paused: false,
        created_at: Date.now(),
      };
      squadsDb.push(cfg);
      createdSquads.push(cfg);
      squadIds.push(sid);
    });
    this.saveSquadsDb(squadsDb);

    this.enqueueBotCreation({
      clanId,
      chunkSizes,
      squadIds,
      password,
      botPrefix,
    });
    return { ok: true, squads: createdSquads };
  }

  updateSquad(input: {
    squad_id: string;
    name?: string;
    target_size?: number;
    game_mode?: string;
    lobby_delay_sec?: number;
    bot_prefix?: string;
    clan_id?: string;
    is_paused?: boolean;
    add_uids?: string[];
    remove_uids?: string[];
  }): SquadConfig | null {
    const sid = String(input.squad_id || '').trim();
    const squads = this.loadSquadsDb();
    const cfg = squads.find((s) => s.id === sid);
    if (!cfg) return null;

    const db = this.loadAccountsDb();
    const removeSet = new Set((input.remove_uids || []).map(String));
    const addSet = new Set((input.add_uids || []).map(String));
    const matchesSelection = (row: SavedAccountRow, selection: Set<string>) => {
      const key = this.resolveAccountKey(String(row.uid));
      const acc = key ? this.accounts.get(key) : undefined;
      return selection.has(String(row.uid)) || Boolean(acc && selection.has(acc.uid));
    };
    const currentMembers = db.filter((row) => this.getSquadKey(row.clan_id, row.squad_id) === sid);
    const remainingMembers = currentMembers.filter((row) => !matchesSelection(row, removeSet)).length;
    const addedMembers = db.filter(
      (row) =>
        matchesSelection(row, addSet) &&
        this.getSquadKey(row.clan_id, row.squad_id) !== sid,
    ).length;
    if (getSquadAvailableSlots(remainingMembers, this.getPendingCreationCount(sid)) < addedMembers) {
      throw new Error(`A squad can have at most ${MAX_SQUAD_SIZE} players`);
    }

    let modeChanged = false;
    if (typeof input.name === 'string' && input.name.trim()) cfg.name = input.name.trim();
    if (input.target_size !== undefined) {
      cfg.target_size = Math.max(2, Math.min(4, Number(input.target_size)));
    }
    if (input.game_mode !== undefined) {
      const nextMode = normalizeGameMode(input.game_mode);
      if (normalizeGameMode(cfg.game_mode) !== nextMode) {
        cfg.game_mode = nextMode;
        modeChanged = true;
      }
    }
    if (input.lobby_delay_sec !== undefined) {
      cfg.lobby_delay_sec = Math.max(0, Math.min(120, Math.floor(Number(input.lobby_delay_sec))));
    }
    if (input.bot_prefix !== undefined) {
      cfg.bot_prefix = sanitizeBotPrefix(input.bot_prefix);
    }
    if (typeof input.clan_id === 'string' && /^\d+$/.test(input.clan_id.trim())) {
      cfg.clan_id = input.clan_id.trim();
    }
    if (typeof input.is_paused === 'boolean') {
      cfg.is_paused = input.is_paused;
    }
    this.saveSquadsDb(squads);

    const toRestart: SavedAccountRow[] = [];

    for (const row of db) {
      const key = this.resolveAccountKey(String(row.uid));
      const acc = key ? this.accounts.get(key) : undefined;
      const matchesRemove = matchesSelection(row, removeSet);
      const matchesAdd = matchesSelection(row, addSet);

      if (matchesRemove && this.getSquadKey(row.clan_id, row.squad_id) === sid) {
        row.squad_id = undefined;
        if (acc) acc.squad_id = null;
        this.closeSocketsForAccount(String(row.uid));
        const rt = this.squadRuntimes.get(sid);
        if (rt && acc) rt.peers.delete(acc.uid);
      } else if (matchesAdd) {
        row.clan_id = cfg.clan_id;
        row.squad_id = sid;
        if (acc) {
          acc.clan_id = cfg.clan_id;
          acc.squad_id = sid;
          acc.guild_joined = false;
        }
        toRestart.push(row);
      } else if (this.getSquadKey(row.clan_id, row.squad_id) === sid) {
        if (row.clan_id !== cfg.clan_id) {
          row.clan_id = cfg.clan_id;
          if (acc) {
            acc.clan_id = cfg.clan_id;
            acc.guild_joined = false;
          }
          toRestart.push(row);
        }
        if (typeof input.is_paused === 'boolean') {
          this.togglePause(String(row.uid), input.is_paused);
          if (!input.is_paused) toRestart.push(row);
        }
      }
    }
    this.saveAccountsDb(db);

    for (const r of toRestart) {
      this.startGuestWorker(r);
    }
    if (modeChanged && !cfg.is_paused) {
      this.rebuildSquadSession(sid, `mode switched to ${cfg.game_mode}`, false);
    }
    this.log(`Squad updated: "${cfg.name}" (${normalizeGameMode(cfg.game_mode)}, ${cfg.lobby_delay_sec ?? 5}s delay)`, 'info');
    return cfg;
  }

  restartSquad(squadId: string): boolean {
    const sid = String(squadId || '').trim();
    const rt = this.squadRuntimes.get(sid);
    if (rt) {
      this.clearSquadLoop(rt);
      rt.modeRevision += 1;
      rt.modeProfileIdx = 0;
      rt.teamCreated = false;
      rt.matchSearching = false;
      rt.searchStartedAt = 0;
      rt.searchRetries = 0;
      rt.matchStartedAt = 0;
      rt.lastMatchEndedAt = 0;
      rt.coordinatorRunning = false;
      rt.startingMatchLock = false;
      rt.teamCode = null;
      rt.teamGroupId = null;
      rt.leaderUid = null;
      rt.peers.clear();
    }
    const db = this.loadAccountsDb().filter((a) => this.getSquadKey(a.clan_id, a.squad_id) === sid);
    for (const row of db) {
      this.togglePause(String(row.uid), false);
      this.startGuestWorker(row);
    }
    this.log(`Restarted Squad ${sid} (${db.length} bots)`, 'info');
    return db.length > 0;
  }

  deleteSquad(squadId: string, deleteAccounts = false): void {
    const sid = String(squadId || '').trim();
    this.activeCreationPending.delete(sid);
    this.creationQueue = this.creationQueue
      .map((j) => {
        const nextSizes: number[] = [];
        const nextIds: string[] = [];
        j.squadIds.forEach((id, idx) => {
          if (id !== sid) {
            nextIds.push(id);
            nextSizes.push(j.chunkSizes[idx]);
          }
        });
        return { ...j, chunkSizes: nextSizes, squadIds: nextIds };
      })
      .filter((j) => j.squadIds.length > 0);
    const rt = this.squadRuntimes.get(sid);
    if (rt) {
      this.clearSquadLoop(rt);
      this.squadRuntimes.delete(sid);
    }
    this.saveSquadsDb(this.loadSquadsDb().filter((s) => s.id !== sid));

    const db = this.loadAccountsDb();
    if (deleteAccounts) {
      for (const row of db) {
        if (this.getSquadKey(row.clan_id, row.squad_id) === sid) {
          this.deleteAccount(String(row.uid));
        }
      }
    } else {
      for (const row of db) {
        if (this.getSquadKey(row.clan_id, row.squad_id) === sid) {
          row.squad_id = undefined;
          const key = this.resolveAccountKey(String(row.uid));
          const acc = key ? this.accounts.get(key) : undefined;
          if (acc) acc.squad_id = null;
          this.closeSocketsForAccount(String(row.uid));
        }
      }
      this.saveAccountsDb(db);
    }
    this.log(`Deleted Squad ${sid}`, 'warning');
  }

  private async createBotsForSquads(
    clanId: string,
    chunkSizes: number[],
    squadIds: string[],
    password: string,
    botPrefix = 'RDX',
  ): Promise<void> {
    this.creating = true;
    this.createProgress = [];
    this.activeCreationPending.clear();
    chunkSizes.forEach((sz, idx) => {
      const sid = squadIds[idx];
      if (sid) {
        this.activeCreationPending.set(sid, (this.activeCreationPending.get(sid) || 0) + sz);
      }
    });
    const cleanPrefix = sanitizeBotPrefix(botPrefix);
    const totalCount = chunkSizes.reduce((s, n) => s + n, 0);
    const prog = (msg: string) => {
      this.createProgress.push(msg);
      this.log(msg, 'info');
    };

    try {
      prog(`Fetching version config for BD...`);
      const vc = await this.versionConfig('BD');
      if (!vc) {
        prog('Version config failed');
        return;
      }
      const gopCandidates = Array.from(
        new Set(
          [vc.gopUrl, 'https://ffmconnect.ppmainecoonghj.com', 'https://100067.connect.garena.com'].filter(
            (u): u is string => Boolean(u) && !u.includes('//connect.garena.com'),
          ),
        ),
      );
      const uaModels = [
        'SM-E135F ;Android 14;en;GB',
        'SM-G998B ;Android 13;en;US',
        'RMX3700 ;Android 14;en;SG',
        '2201122G ;Android 13;en;BD',
        'CPH2451 ;Android 14;en;IN',
      ];
      const slotSquadIds: string[] = [];
      chunkSizes.forEach((sz, idx) => {
        for (let k = 0; k < sz; k++) slotSquadIds.push(squadIds[idx]);
      });

      const created: SavedAccountRow[] = [];
      let attempts = 0;
      const maxAttempts = Math.max(totalCount * 6, 16);

      while (created.length < totalCount && attempts < maxAttempts) {
        const gopBase = gopCandidates[attempts % gopCandidates.length];
        const uaModel = uaModels[attempts % uaModels.length];
        const msdkUa = `GarenaMSDK/4.0.44(${uaModel};app ${vc.appVersion} 2019118525;)`;
        attempts += 1;
        prog(`Creating bot ${created.length + 1}/${totalCount} (Attempt ${attempts})...`);
        try {
          const regBody = JSON.stringify({ app_id: 100067, client_type: 2, password, source: 2 });
          const regRes = await httpRequest(`${gopBase}/api/v2/oauth/guest:register`, {
            method: 'POST',
            headers: {
              'User-Agent': msdkUa,
              Authorization: `Signature ${generateSignature(regBody)}`,
              Accept: 'application/json',
              'Content-Type': 'application/json; charset=utf-8',
            },
            body: regBody,
            timeoutMs: 15000,
          });
          let regJson: { code?: number; error?: string; data?: { uid?: string | number } } = {};
          try {
            regJson = JSON.parse(regRes.body.toString('utf8'));
          } catch {
            regJson = {};
          }
          if (regRes.status !== 200 || regJson.code !== 0 || !regJson.data?.uid) {
            if (isAccountRegistrationRateLimited(regRes.status, regJson.code, regJson.error)) {
              prog('Account registration rate-limited by provider; stopped repeated requests. Add existing accounts or retry later.');
              break;
            } else {
              const reason = String(regJson.error || `HTTP ${regRes.status} code=${regJson.code ?? 'unknown'}`).replace(
                /^error_/,
                '',
              );
              prog(`Register retry (${reason}), waiting...`);
              await sleep(3000);
            }
            continue;
          }

          const uid = String(regJson.data.uid);
          const grantBody = JSON.stringify({
            client_id: 100067,
            client_secret: HEX_KEY,
            client_type: 2,
            device_id: `02-${crypto.randomUUID()}`,
            password,
            response_type: 'token',
            uid: Number(uid),
          });
          const grantRes = await httpRequest(`${gopBase}/api/v2/oauth/guest/token:grant`, {
            method: 'POST',
            headers: {
              'User-Agent': msdkUa,
              Authorization: `Signature ${generateSignature(grantBody)}`,
              Accept: 'application/json',
              'Content-Type': 'application/json; charset=utf-8',
            },
            body: grantBody,
            timeoutMs: 15000,
          });
          let grantJson: {
            code?: number;
            error?: string;
            data?: { open_id: string; access_token: string; platform?: number };
          } = {};
          try {
            grantJson = JSON.parse(grantRes.body.toString('utf8'));
          } catch {
            grantJson = {};
          }
          if (grantRes.status !== 200 || grantJson.code !== 0 || !grantJson.data) {
            const gReason = String(grantJson.error || grantRes.status).replace(/^error_/, '');
            prog(`Grant token retry for ${uid} (${gReason})...`);
            await sleep(2500);
            continue;
          }

          const { open_id, access_token } = grantJson.data;
          const platform = Number(grantJson.data.platform || 4);
          const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
          const suffixLen = Math.max(3, Math.min(5, 11 - cleanPrefix.length));
          let suffix = '';
          for (let k = 0; k < suffixLen; k++) suffix += chars[Math.floor(Math.random() * chars.length)];
          const nick = `${cleanPrefix}•${suffix}`;
          const f14 = Buffer.from(open_id, 'utf8');
          for (let k = 0; k < f14.length; k++) f14[k] ^= KEYSTREAM[k % KEYSTREAM.length];
          const mrProto = encodeProtoStd({
            1: nick,
            2: access_token,
            3: open_id,
            5: 102000007,
            6: 4,
            7: 1,
            13: 1,
            14: f14,
            15: 'bn',
            16: 2,
            20: '2.132.4',
            21: 1,
            22: GGRE_RAW,
          });
          const mrRes = await httpRequest(`${vc.serverUrl.replace(/\/+$/, '')}/MajorRegister`, {
            method: 'POST',
            headers: {
              Accept: '*/*',
              'Accept-Encoding': 'deflate, gzip',
              Authorization: 'Bearer',
              'Content-Type': 'application/x-www-form-urlencoded',
              ReleaseVersion: vc.releaseVersion,
              'User-Agent': 'UnityPlayer/2018.4.12f1',
              'X-GA': 'v1 1',
              'X-GA-SV': String(Math.floor(Date.now() / 1000)),
              'X-Unity-Version': '2018.4.12f1',
            },
            body: aesEncrypt(mrProto),
            timeoutMs: 20000,
          });
          if (mrRes.status !== 200) {
            prog(`MajorRegister HTTP ${mrRes.status}, retrying...`);
            await sleep(2500);
            continue;
          }

          await sleep(1600);
          const dev = getDeviceForAccount(uid);
          const { majorPayload } = this.buildLoginPayloads(
            access_token,
            open_id,
            platform,
            vc.remoteVersion,
            String(dev.unique_device_id),
          );
          const ml1 = await this.majorLogin(majorPayload, vc.serverUrl, vc.releaseVersion);
          if (ml1 && !ml1.serverUrl && ml1.jwtToken) {
            await this.chooseRegion('BD', ml1.jwtToken, vc.serverUrl, vc.releaseVersion);
            await sleep(900);
          }

          const assignedSquadId = slotSquadIds[created.length] || squadIds[0];
          const row: SavedAccountRow = {
            uid,
            password,
            region: 'BD',
            clan_id: clanId,
            squad_id: assignedSquadId,
            bot_prefix: cleanPrefix,
            nickname: nick,
          };
          created.push(row);

          // Decrement pending count for this squad and persist + launch worker immediately
          // so earlier squads start connecting & grouping right away without waiting for later squads.
          const prevPending = this.activeCreationPending.get(assignedSquadId) || 0;
          if (prevPending > 1) this.activeCreationPending.set(assignedSquadId, prevPending - 1);
          else this.activeCreationPending.delete(assignedSquadId);

          const db = this.loadAccountsDb();
          if (!db.some((x) => String(x.uid) === row.uid)) {
            db.push(row);
            this.saveAccountsDb(db);
          }
          this.startGuestWorker(row);

          prog(`Bot ${created.length}/${totalCount} created: ${nick} (UID ${uid}) -> Squad ${assignedSquadId}`);
          if (created.length < totalCount) {
            await sleep(2600);
          }
        } catch (err) {
          prog(`Attempt ${attempts} retry: ${(err as Error).message}`);
          await sleep(2500);
        }
      }
    } catch (e) {
      prog(`Create team failed: ${(e as Error).message}`);
    } finally {
      this.activeCreationPending.clear();
      this.creating = false;
      for (const sid of squadIds) {
        if (sid) {
          setTimeout(() => void this.runSquadCoordinator(sid), 1200);
        }
      }
    }
  }

  async createTeamBots(
    clanId: string,
    count: number,
    password: string,
    opts?: {
      squadId?: string;
      squadName?: string;
      gameMode?: string;
      lobbyDelaySec?: number;
      botPrefix?: string;
    },
  ): Promise<{ ok: boolean; squads: SquadConfig[]; error?: string }> {
    return this.createSquad({
      clan_id: clanId,
      target_squad_id: opts?.squadId || undefined,
      name: opts?.squadName || undefined,
      game_mode: opts?.gameMode,
      lobby_delay_sec: opts?.lobbyDelaySec,
      bot_prefix: opts?.botPrefix,
      mode: 'create_bots',
      count,
      target_size: Math.min(4, Math.max(2, count)),
      password,
    });
  }

  deleteAccount(uid: string, authUid?: string): void {
    const targets = new Set<string>();
    if (uid) for (const id of this.linkedIds(uid)) targets.add(id);
    if (authUid) for (const id of this.linkedIds(authUid)) targets.add(id);

    const db = this.loadAccountsDb();
    this.archiveAccounts(db.filter((row) => targets.has(String(row.uid))), 'Removed from engine');
    for (const id of targets) {
      this.recentDeletedUids.add(id);
      const w = this.workers.get(id);
      if (w) {
        w.cancelled = true;
        w.mainClosed = true;
        for (const u of w.udpHandles) {
          try {
            u.stop();
          } catch {
            // ignore
          }
        }
        w.udpHandles.clear();
        for (const s of w.sockets) {
          try {
            s.destroy();
          } catch {
            // ignore
          }
        }
        for (const t of w.timers) clearTimeout(t);
        this.workers.delete(id);
      }
      this.accounts.delete(id);
      this.credentials.delete(id);
      this.pausedIds.delete(id);
      this.invalidateCache(id);
      for (const rt of this.squadRuntimes.values()) {
        rt.peers.delete(id);
      }
    }

    this.saveAccountsDb(db.filter((a) => !targets.has(String(a.uid))));
    this.log(`Removed account ${uid || authUid}`, 'warning');
  }

  clearAllAccounts(): number {
    const db = this.loadAccountsDb();
    this.archiveAccounts(db, 'Cleared from engine');
    const removedCount = Math.max(db.length, this.accounts.size);
    this.creationQueue = [];
    this.activeCreationPending.clear();
    const allIds = new Set<string>([
      ...Array.from(this.workers.keys()),
      ...Array.from(this.accounts.keys()),
      ...db.map((r) => String(r.uid)),
    ]);
    for (const id of allIds) {
      this.recentDeletedUids.add(id);
      const w = this.workers.get(id);
      if (w) {
        w.cancelled = true;
        w.mainClosed = true;
        for (const u of w.udpHandles) {
          try {
            u.stop();
          } catch {
            // ignore
          }
        }
        for (const s of w.sockets) {
          try {
            s.destroy();
          } catch {
            // ignore
          }
        }
        for (const t of w.timers) clearTimeout(t);
      }
    }
    this.workers.clear();
    this.accounts.clear();
    this.credentials.clear();
    this.pausedIds.clear();
    for (const rt of this.squadRuntimes.values()) {
      this.clearSquadLoop(rt);
      rt.peers.clear();
      rt.teamCreated = false;
      rt.matchSearching = false;
      rt.teamCode = null;
      rt.teamGroupId = null;
      rt.leaderUid = null;
    }
    this.saveAccountsDb([]);
    this.saveTokenCache({});
    this.log(`Cleared all ${removedCount} bot account(s)`, 'warning');
    return removedCount;
  }

  listLostAccounts(): RecoveryAccountInfo[] {
    return this.loadLostAccountsDb()
      .slice()
      .reverse()
      .map((row) => ({
        uid: String(row.uid),
        nickname: row.nickname,
        region: String(row.region || 'BD'),
        clan_id: String(row.clan_id || ''),
        squad_id: row.squad_id,
        status: 'REMOVED',
        removed_at: row.removed_at,
        removal_reason: row.removal_reason,
      }));
  }

  listRecoverableAccounts(): RecoveryAccountInfo[] {
    return this.loadAccountsDb()
      .map((row) => {
        const key = this.resolveAccountKey(String(row.uid));
        const account = key ? this.accounts.get(key) : undefined;
        const status = account?.status || 'CONNECTING';
        return {
          uid: String(row.uid),
          nickname: row.nickname || account?.nickname,
          region: String(row.region || 'BD'),
          clan_id: String(row.clan_id || ''),
          squad_id: row.squad_id,
          status,
        };
      })
      .filter((row) => ['OFFLINE', 'BANNED'].includes(row.status));
  }

  async recoverAccount(uid: string): Promise<{ ok: boolean; restored?: boolean; error?: string }> {
    const targetUid = String(uid || '').trim();
    if (!targetUid) return { ok: false, error: 'uid required' };

    const db = this.loadAccountsDb();
    const existing = db.find((row) => String(row.uid) === targetUid);
    if (existing) {
      this.togglePause(targetUid, false);
      this.startGuestWorker(existing);
      this.log(`Reconnect requested for ${targetUid}; saved account retained`, 'info');
      return { ok: true, restored: false };
    }

    const archive = this.loadLostAccountsDb();
    const archived = archive.find((row) => String(row.uid) === targetUid);
    if (!archived) return { ok: false, error: 'Player was not found in the recovery archive' };

    const restored: SavedAccountRow = {
      uid: archived.uid,
      password: archived.password,
      region: archived.region,
      clan_id: archived.clan_id || CLAN_ID_DEFAULT,
      squad_id: archived.squad_id,
      bot_prefix: archived.bot_prefix,
      nickname: archived.nickname,
      max_matches: archived.max_matches,
      max_hours: archived.max_hours,
      replacement_pending_match: archived.replacement_pending_match,
    };
    const squad = this.loadSquadsDb().find(
      (item) => item.id === restored.squad_id && item.clan_id === restored.clan_id,
    );
    if (squad) {
      const currentMembers = db.filter(
        (row) => this.getSquadKey(row.clan_id, row.squad_id) === squad.id,
      ).length;
      if (getSquadAvailableSlots(currentMembers, this.getPendingCreationCount(squad.id)) === 0) {
        restored.squad_id = await this.ensureSquadForAdd(
          restored.clan_id,
          undefined,
          `Recovered ${restored.uid.slice(-4)}`,
        );
      }
    } else {
      restored.squad_id = await this.ensureSquadForAdd(
        restored.clan_id,
        undefined,
        `Recovered ${restored.uid.slice(-4)}`,
      );
    }

    db.push(restored);
    this.saveAccountsDb(db);
    this.saveLostAccountsDb(archive.filter((row) => String(row.uid) !== targetUid));
    for (const id of this.linkedIds(targetUid)) this.recentDeletedUids.delete(id);
    this.startGuestWorker(restored);
    this.log(`Restored player ${targetUid} from the recovery archive`, 'success');
    return { ok: true, restored: true };
  }

  syncWorkspaceFromCloud(input: {
    guilds?: GuildConfig[];
    squads?: SquadConfig[];
    accounts?: SavedAccountRow[];
  }): { restoredGuilds: number; restoredSquads: number; restoredAccounts: number } {
    const curGuilds = this.loadGuildsDb();
    const curGuildMap = new Map(curGuilds.map((g) => [g.clan_id, g]));
    let restoredGuilds = 0;

    if (Array.isArray(input.guilds)) {
      for (const g of input.guilds) {
        if (!g?.clan_id || curGuildMap.has(g.clan_id)) continue;
        curGuilds.push({
          clan_id: String(g.clan_id),
          name: String(g.name || `Guild ${g.clan_id}`),
          region: String(g.region || 'BD'),
          verified: Boolean(g.verified),
          created_at: Number(g.created_at || Date.now()),
          duration_days: Number(g.duration_days || 0),
          duration_hours: Number(g.duration_hours || 0),
          duration_minutes: Number(g.duration_minutes || 0),
          expires_at: g.expires_at ?? null,
          is_paused: Boolean(g.is_paused),
        });
        curGuildMap.set(String(g.clan_id), g);
        restoredGuilds += 1;
      }
      if (restoredGuilds > 0) this.saveGuildsDb(curGuilds);
    }

    const curSquads = this.loadSquadsDb();
    const curSquadMap = new Map(curSquads.map((s) => [s.id, s]));
    let restoredSquads = 0;

    if (Array.isArray(input.squads)) {
      for (const s of input.squads) {
        if (!s?.id || curSquadMap.has(s.id)) continue;
        curSquads.push({
          id: String(s.id),
          clan_id: String(s.clan_id || ''),
          name: String(s.name || 'Squad'),
          target_size: Math.max(2, Math.min(4, Number(s.target_size || 4))),
          game_mode: normalizeGameMode(s.game_mode),
          lobby_delay_sec: Math.max(0, Math.min(120, Number(s.lobby_delay_sec ?? 5))),
          bot_prefix: sanitizeBotPrefix(s.bot_prefix),
          is_paused: Boolean(s.is_paused),
          created_at: Number(s.created_at || Date.now()),
        });
        curSquadMap.set(String(s.id), s);
        restoredSquads += 1;
      }
      if (restoredSquads > 0) this.saveSquadsDb(curSquads);
    }

    const curAccs = this.loadAccountsDb();
    const curAccSet = new Set(curAccs.map((a) => String(a.uid)));
    const newlyAdded: SavedAccountRow[] = [];

    if (Array.isArray(input.accounts)) {
      for (const a of input.accounts) {
        const uid = String(a?.uid || '').trim();
        if (!uid || !a.password || curAccSet.has(uid) || this.recentDeletedUids.has(uid)) continue;
        const row: SavedAccountRow = {
          uid,
          password: String(a.password),
          region: String(a.region || 'BD'),
          clan_id: String(a.clan_id || ''),
          squad_id: a.squad_id ? String(a.squad_id) : undefined,
          bot_prefix: sanitizeBotPrefix(a.bot_prefix),
          nickname: a.nickname ? String(a.nickname) : undefined,
          max_matches: Number(a.max_matches || 0),
          max_hours: Number(a.max_hours || 0),
        };
        curAccs.push(row);
        curAccSet.add(uid);
        newlyAdded.push(row);
      }
      if (this.enforceSquadCapacity(curAccs, curSquads)) this.saveSquadsDb(curSquads);
      if (newlyAdded.length > 0) {
        this.saveAccountsDb(curAccs);
        for (const r of newlyAdded) {
          this.startGuestWorker(r);
        }
      }
    }

    if (restoredGuilds > 0 || restoredSquads > 0 || newlyAdded.length > 0) {
      this.log(
        `Cloud Restore: ${restoredGuilds} guild(s), ${restoredSquads} squad(s), ${newlyAdded.length} bot(s) synced`,
        'success',
      );
    }
    return { restoredGuilds, restoredSquads, restoredAccounts: newlyAdded.length };
  }

  restartAccount(uid: string): boolean {
    const ids = this.linkedIds(uid);
    this.togglePause(uid, false);
    const db = this.loadAccountsDb();
    for (const row of db) {
      if (ids.has(String(row.uid))) {
        this.invalidateCache(String(row.uid));
        this.startGuestWorker(row);
        this.log(`Restarted worker ${row.uid}`, 'info');
        return true;
      }
    }
    return false;
  }

  private startExpiryWatcher(): void {
    if (this.expiryWatcher) return;
    this.expiryWatcher = setInterval(() => {
      const guilds = this.loadGuildsDb();
      const now = Date.now();
      for (const g of guilds) {
        if (!g.is_paused && g.expires_at !== null && now >= g.expires_at) {
          const accs = this.loadAccountsDb().filter((a) => String(a.clan_id) === g.clan_id);
          let pausedAny = false;
          for (const a of accs) {
            if (!this.isPaused(String(a.uid))) {
              this.togglePause(String(a.uid), true);
              pausedAny = true;
            }
          }
          if (pausedAny) {
            this.log(`Guild "${g.name}" (${g.clan_id}) active timer expired — bots paused`, 'warning');
          }
        }
      }
    }, 5000);
  }

  getStatsPayload() {
    const guildsDb = this.loadGuildsDb();
    const squadsDb = this.loadSquadsDb();
    const accountsDb = this.loadAccountsDb();
    const guildMap = new Map(guildsDb.map((g) => [g.clan_id, g]));
    const squadMap = new Map(squadsDb.map((s) => [s.id, s]));

    const accs = Array.from(this.accounts.values()).map((a) => {
      const skey = a.squad_id || this.getSquadKey(a.clan_id, null);
      const rt = this.squadRuntimes.get(skey);
      const peer = rt?.peers.get(a.uid);
      const sqCfg = squadMap.get(skey);
      const gCfg = a.clan_id ? guildMap.get(a.clan_id) : undefined;
      return {
        ...a,
        squad_id: a.squad_id || skey,
        squad_name: sqCfg?.name || a.squad_name || null,
        clan_name: a.clan_name || gCfg?.name,
        in_squad: Boolean(peer?.inSquad),
        is_leader: Boolean(rt && rt.leaderUid === a.uid),
        team_code: rt?.teamCode || null,
        uptime_seconds: this.getAccountUptime(a.uid),
        is_paused: this.isPaused(a.uid),
        matches_played: a.matches,
      };
    });
    accs.sort((a, b) => (b.gained_exp || 0) - (a.gained_exp || 0));

    const onlineStatuses = new Set([
      'ONLINE',
      'IN_MATCH',
      'SEARCHING',
      'IN MATCH',
      'GUILD JOINED',
      'SQUAD CREATING',
      'SQUAD JOINING',
      'SQUAD JOINED',
      'GUILD JOIN SEND',
      'CONNECTING',
    ]);
    const online = accs.filter((a) => !a.is_paused && onlineStatuses.has(a.status)).length;
    const activeMatches = accs.reduce((sum, a) => sum + (a.active_matches || 0), 0);
    const uptime = Math.max(1, Math.floor((Date.now() - this.startTime) / 1000));
    const upHours = Math.max(0.016, uptime / 3600);
    const expPerHour = Math.floor(this.totalExpGained / upHours);
    const matchesPerHour = Math.floor(this.matchesStarted / upHours);

    const now = Date.now();
    const squadsOut = squadsDb.map((sq) => {
      const rt = this.squadRuntimes.get(sq.id);
      const gCfg = guildMap.get(sq.clan_id);
      const dbMemberUids = accountsDb
        .filter((r) => this.getSquadKey(r.clan_id, r.squad_id) === sq.id)
        .map((r) => this.resolveAccountKey(String(r.uid)) || String(r.uid));
      const sqAccs = accs.filter((a) => (a.squad_id || this.getSquadKey(a.clan_id, null)) === sq.id);
      const uids = Array.from(new Set([...dbMemberUids, ...sqAccs.map((a) => a.uid)]));
      const pendingCreations = this.getPendingCreationCountForSquad(sq.id, sq.clan_id);
      const effectiveTargetSize = getEffectiveSquadSize(
        sq.target_size,
        uids.length,
        pendingCreations,
      );
      const inMatchCount = sqAccs.filter((a) => a.status === 'IN_MATCH').length;
      const searchingCount = sqAccs.filter((a) => a.status === 'SEARCHING').length;
      const retryPendingCount = sqAccs.filter((a) => a.status === 'MATCH_CANCELLED').length;
      const inSquadCount = sqAccs.filter((a) => a.in_squad).length;
      const guildJoinedCount = sqAccs.filter((a) => a.guild_joined).length;
      const onlineCount = sqAccs.filter((a) => !a.is_paused && onlineStatuses.has(a.status)).length;
      const provisioningStatus = getSquadProvisioningStatus(
        uids.length,
        effectiveTargetSize,
        pendingCreations,
      );
      const nextMatchAt = rt?.lastMatchEndedAt
        ? rt.lastMatchEndedAt + this.getSquadLobbyDelayMs(sq.id)
        : 0;

      let sqStatus = 'IDLE';
      if (sq.is_paused || gCfg?.is_paused) sqStatus = 'PAUSED';
      else if (inMatchCount > 0) sqStatus = 'IN MATCH';
      else if (rt?.matchSearching || searchingCount > 0) sqStatus = 'SEARCHING';
      else if (retryPendingCount > 0) sqStatus = 'MATCH RETRY';
      else if (provisioningStatus) sqStatus = provisioningStatus;
      else if (inSquadCount >= 2) sqStatus = 'SQUAD READY';
      else if (guildJoinedCount > 0) sqStatus = 'GUILD JOINED';
      else if (onlineCount > 0) sqStatus = 'CONNECTING';

      return {
        ...sq,
        target_size: effectiveTargetSize,
        game_mode: normalizeGameMode(sq.game_mode),
        lobby_delay_sec: Math.max(0, Math.min(120, Number(sq.lobby_delay_sec ?? 5))),
        bot_prefix: sanitizeBotPrefix(sq.bot_prefix),
        clan_name: gCfg?.name || sqAccs.find((a) => a.clan_name)?.clan_name || `Guild ${sq.clan_id}`,
        team_code: rt?.teamCode || null,
        group_id: rt?.teamGroupId || null,
        leader_uid: rt?.leaderUid || null,
        status: sqStatus,
        member_uids: uids,
        online_count: onlineCount,
        guild_joined_count: guildJoinedCount,
        in_squad_count: inSquadCount,
        in_match_count: inMatchCount,
        match_recovering_count: sqAccs.filter((a) => a.status === 'MATCH_RESUMING').length,
        completed_matches_in_cycle: clampInteger(sq.completed_matches_in_cycle ?? 0, 0, 0, MATCH_CYCLE_RESET_AFTER - 1),
        match_reset_threshold: MATCH_CYCLE_RESET_AFTER,
        matchmaking_started_at: rt?.matchSearching ? rt.searchStartedAt : 0,
        match_started_at: rt?.matchStartedAt || 0,
        next_match_at: nextMatchAt,
        next_match_in_sec: getNextMatchCountdownSeconds(nextMatchAt, now),
      };
    });

    const guildsOut = guildsDb.map((g) => {
      const gSquads = squadsOut.filter((s) => s.clan_id === g.clan_id);
      const gAccs = accs.filter((a) => a.clan_id === g.clan_id);
      const remainingSeconds =
        g.expires_at === null ? null : Math.max(0, Math.floor((g.expires_at - now) / 1000));
      const expired = g.expires_at !== null && now >= g.expires_at;
      return {
        ...g,
        remaining_seconds: remainingSeconds,
        expired,
        squad_count: gSquads.length,
        player_count: gAccs.length,
        guild_joined_count: gAccs.filter((a) => a.guild_joined).length,
      };
    });

    const firstRt = Array.from(this.squadRuntimes.values()).find((r) => r.teamCode) ||
      Array.from(this.squadRuntimes.values())[0];

    return {
      accounts: accs,
      saved_accounts: accountsDb,
      deleted_uids: Array.from(this.recentDeletedUids).slice(-100),
      lost_accounts: this.listLostAccounts(),
      recoverable_accounts: this.listRecoverableAccounts(),
      guilds: guildsOut,
      squads: squadsOut,
      logs: this.logs.slice(-200),
      total_accounts: accs.length,
      total_online: online,
      total_matches: this.totalMatches,
      total_matches_started: this.matchesStarted,
      total_active_matches: activeMatches,
      total_gained_exp: this.totalExpGained,
      uptime,
      exp_per_hour: expPerHour,
      matches_per_hour: matchesPerHour,
      creating: this.creating || this.creationQueue.length > 0,
      create_progress: this.createProgress.slice(-40),
      team_code: firstRt?.teamCode || null,
      leader_uid: firstRt?.leaderUid || null,
      team_size: Array.from(this.squadRuntimes.values()).reduce((sum, r) => sum + r.peers.size, 0),
      restart_finished: 0,
      restart_target: null,
      restarting: false,
    };
  }

  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    this.log('RDX TEM Engine booting (BD Edition)...', 'info');
    this.syncHierarchyFromAccounts();
    this.startExpiryWatcher();
    const db = this.loadAccountsDb();
    this.log(`Auto-loading ${db.length} account(s) from accounts.json`, 'info');
    for (let i = 0; i < db.length; i++) {
      this.startGuestWorker(db[i]);
      await sleep(350);
    }
  }
}

interface VersionInfo {
  releaseVersion: string;
  remoteVersion: string;
  serverUrl: string;
  gopUrl: string;
  appVersion: string;
}

export const engine = new RdxEngine();
