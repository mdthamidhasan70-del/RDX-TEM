export type PageId = 'core' | 'targets' | 'squad' | 'terminal';

export type StatusCategory = 'paused' | 'match' | 'online' | 'search' | 'error';

export type GameModeId = 'BR_RANK' | 'CS_RANK';

export const GAME_MODE_LABELS: Record<GameModeId, string> = {
  BR_RANK: 'BR Rank',
  CS_RANK: 'CS Rank',
};

export function normalizeGameMode(raw?: unknown): GameModeId {
  const s = String(raw || 'BR_RANK').toUpperCase().replace(/[\s-]+/g, '_');
  if (s === 'CS' || s === 'CLASH_SQUAD' || s === 'CS_RANK' || s === 'CS_RANKED' || s === 'CLASH_SQUAD_RANK') {
    return 'CS_RANK';
  }
  return 'BR_RANK';
}

export interface BotAccount {
  uid: string;
  auth_uid?: string;
  nickname: string;
  region: string;
  level: number;
  exp?: number;
  current_exp: number;
  initial_exp: number;
  gained_exp: number;
  matches?: number;
  matches_played?: number;
  active_matches?: number;
  status: string;
  is_paused?: boolean;
  uptime_seconds?: number;
  squad_id?: string | null;
  squad_name?: string | null;
  clan_id?: string;
  clan_name?: string;
  guild_joined?: boolean;
  in_squad?: boolean;
  is_leader?: boolean;
  team_code?: string | null;
  avatar?: string;
}

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
}

export interface GuildInfo {
  clan_id: string;
  name: string;
  region: string;
  verified: boolean;
  created_at: number;
  duration_days: number;
  duration_hours: number;
  duration_minutes: number;
  expires_at: number | null;
  remaining_seconds: number | null;
  expired: boolean;
  is_paused: boolean;
  squad_count: number;
  player_count: number;
  guild_joined_count: number;
}

export interface SquadInfo {
  id: string;
  clan_id: string;
  clan_name: string;
  name: string;
  target_size: number;
  game_mode: GameModeId;
  lobby_delay_sec: number;
  bot_prefix: string;
  is_paused: boolean;
  created_at: number;
  team_code: string | null;
  group_id: string | null;
  leader_uid: string | null;
  status: string;
  member_uids: string[];
  online_count: number;
  guild_joined_count: number;
  in_squad_count: number;
  in_match_count: number;
  match_recovering_count?: number;
  completed_matches_in_cycle: number;
  match_reset_threshold: number;
  matchmaking_started_at?: number;
  match_started_at?: number;
  next_match_at?: number;
  next_match_in_sec?: number;
}

export interface LogEntry {
  time: string;
  level: 'info' | 'success' | 'warning' | 'error' | string;
  message: string;
}

export interface StatsResponse {
  accounts: BotAccount[];
  saved_accounts?: SavedAccountRow[];
  deleted_uids?: string[];
  guilds?: GuildInfo[];
  squads?: SquadInfo[];
  logs: LogEntry[];
  total_accounts: number;
  total_online?: number;
  total_matches: number;
  total_matches_started: number;
  total_active_matches: number;
  total_gained_exp: number;
  exp_per_hour: number;
  matches_per_hour?: number;
  uptime: number;
  team_code?: string | null;
  leader_uid?: string | null;
  team_size?: number;
  creating?: boolean;
  create_progress?: string[];
}

export interface NotificationItem {
  id: string;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  time: string;
  read: boolean;
}

export interface ToastItem {
  id: string;
  message: string;
  type: 'info' | 'success' | 'error';
}

export const EXP_TABLE: Record<number, number> = {
  1: 0, 2: 48, 3: 202, 4: 544, 5: 1012, 6: 1844, 7: 2792, 8: 3800, 9: 4870, 10: 6004,
  11: 7192, 12: 8448, 13: 9760, 14: 11140, 15: 12566, 16: 14060, 17: 15610, 18: 17224,
  19: 18902, 20: 20632, 21: 22424, 22: 24278, 23: 26192, 24: 28166, 25: 30200, 26: 32294,
  27: 34448, 28: 37804, 29: 41274, 30: 44870, 31: 48582, 32: 53394, 33: 58566, 34: 64096,
  35: 69994, 36: 76460, 37: 83506, 38: 91128, 39: 99322, 40: 108092, 41: 120144, 42: 133266,
  43: 147472, 44: 162760, 45: 179126, 46: 196572, 47: 215368, 48: 235516, 49: 257010,
  50: 279860, 51: 304056, 52: 348318, 53: 394982, 54: 444044, 55: 495508, 56: 549364,
  57: 633756, 58: 721744, 59: 813336, 60: 908522, 61: 1041438, 62: 1180352, 63: 1325266,
  64: 1476184, 65: 1634300, 66: 1840946, 67: 2056594, 68: 2281242, 69: 2514880, 70: 2757530,
  71: 3059506, 72: 3372284, 73: 3699456, 74: 4041030, 75: 4397002, 76: 4829104, 77: 5282204,
  78: 5756304, 79: 6251408, 80: 6776502, 81: 7381324, 82: 8043154, 83: 8752982, 84: 9510808,
  85: 10316338, 86: 11277190, 87: 12291748, 88: 13360304, 89: 14482858, 90: 15659418,
  91: 17026708, 92: 18453950, 93: 19941280, 94: 21488570, 95: 23095858, 96: 24763138,
  97: 26490428, 98: 28378704, 99: 30124996, 100: 32032884,
};

export function formatStatusText(
  status: string,
  gameMode: GameModeId = 'BR_RANK',
): string {
  const raw = String(status || 'ONLINE').trim();
  if (!raw) return 'ONLINE';
  const s = raw.toUpperCase().replace(/\s+/g, '_');

  if (s === 'SEARCHING' || s === 'MATCHING' || s === 'MATCH_SEARCHING') {
    return `${GAME_MODE_LABELS[gameMode]} request unconfirmed`;
  }
  if (s === 'MATCH_RESUMING') return 'Reconnecting to Match';
  if (s === 'START_MATCH' || s === 'MATCH_READY' || s === 'SQUAD_READY') return 'Match Starting';
  if (s === 'MATCH_RUNNING' || s === 'IN_MATCH') return 'In Match';
  if (s === 'MATCH_CANCELLED') return 'Match retry pending';
  if (s === 'MATCH_RETRY') return 'Match retry pending';
  if (s === 'CANCELLED' || s === 'CANCELED') return 'Cancelled';
  if (s === 'GUILD_JOINED') return 'Guild Joined';
  if (s === 'SQUAD_JOINED') return 'Squad Joined';
  if (s === 'SQUAD_CREATING') return 'Creating Squad';
  if (s === 'NEEDS_PLAYERS') return 'Needs Players';
  if (s === 'SQUAD_CREATE_REJECTED') return 'Squad Creation Rejected';
  if (s === 'SQUAD_JOINING') return 'Joining Squad';
  if (s === 'GUILD_JOIN_SEND') return 'Guild Sync';
  if (s === 'CONNECTING') return 'Connecting';
  if (s === 'OFFLINE') return 'Offline';
  if (s === 'BANNED') return 'Banned';
  if (s === 'PAUSED') return 'Paused';
  return raw;
}

export function normalizeCategory(acc: Pick<BotAccount, 'status' | 'is_paused'>): StatusCategory {
  if (acc.is_paused || String(acc.status || '').toUpperCase() === 'PAUSED') return 'paused';
  const s = String(acc.status || 'ONLINE').toUpperCase().replace(/\s+/g, '_');
  if (s === 'IN_MATCH' || s === 'MATCH_RUNNING') return 'match';
  if (s === 'ONLINE' || s === 'GUILD_JOINED' || s === 'SQUAD_JOINED' || s === 'FINISHED') return 'online';
  if (
    s === 'SEARCHING' ||
    s === 'MATCHING' ||
    s === 'MATCH_RESUMING' ||
    s === 'CONNECTING' ||
    s === 'GUILD_JOIN_SEND' ||
    s === 'SQUAD_CREATING' ||
    s === 'SQUAD_JOINING' ||
    s === 'MATCH_CANCELLED' ||
    s === 'CANCELLED' ||
    s === 'CANCELED' ||
    s === 'START_MATCH' ||
    s === 'MATCH_READY' ||
    s === 'SQUAD_READY'
  ) {
    return 'search';
  }
  return 'error';
}

export function formatDuration(seconds: number): string {
  const sec = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${pad(h)}h ${pad(m)}m`;
  return h > 0 ? `${h}h ${pad(m)}m` : `${pad(m)}m ${pad(s)}s`;
}

export function formatClock(seconds: number): string {
  const sec = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function computeLevelProgress(levelRaw: number, currentExpRaw: number) {
  const level = Math.min(100, Math.max(1, Math.floor(Number(levelRaw) || 1)));
  const isMax = level >= 100;
  const nextLvl = Math.min(100, level + 1);
  const baseExp = EXP_TABLE[level] ?? 0;
  const target = EXP_TABLE[nextLvl] ?? baseExp + 50000;
  const needed = Math.max(1, target - baseExp);
  const curExp = Number(currentExpRaw || 0);
  const earned = Math.max(0, curExp - baseExp);
  const remaining = Math.max(0, target - curExp);
  const pct = isMax ? 100 : Math.min(100, Math.max(0, (earned / needed) * 100));
  return { level, nextLvl, isMax, curExp, earned, needed, remaining, pct };
}

export function nowTimeStr(): string {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

export function ffAvatar(uid: string, seed?: string): string {
  const styles = ['adventurer', 'bottts', 'avataaars', 'lorelei', 'micah', 'notionists'];
  const style = styles[Math.floor((parseInt(uid, 10) || 0) % styles.length)];
  const s = encodeURIComponent(seed || String(uid));
  return `https://api.dicebear.com/7.x/${style}/svg?seed=${s}&backgroundColor=transparent&scale=85`;
}
