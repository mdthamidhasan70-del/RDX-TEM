import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  Bell,
  Bot,
  Check,
  CheckCheck,
  ChevronRight,
  Clock,
  Cloud,
  Copy,
  Crosshair,
  Flame,
  Gamepad2,
  Gauge,
  Globe,
  LogOut,
  Minimize2,
  Maximize2,
  Music,
  Network,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Share2,
  Shield,
  Terminal,
  Trash2,
  TriangleAlert,
  User,
  Users,
  VolumeX,
  X,
} from 'lucide-react';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import {
  auth,
  clearUserAccountDocs,
  ensureUserProfileDoc,
  googleProvider,
  loadUserWorkspace,
  removeAccountDoc,
  removeGuildDoc,
  removeSquadDoc,
  testConnection,
  upsertAccountDoc,
  upsertGuildDoc,
  upsertSquadDoc,
} from './firebase';
import { LoginEntry, SESSION_KEY, getSavedSession, type AuthSession } from './components/LoginEntry';
import { AddAccountModal, ConfirmModal, CreateTeamModal, EngineModal } from './components/Modals';
import { MySquadView } from './components/MySquadView';
import { RdxBackground, RdxEmblem } from './components/RdxBackground';
import {
  GAME_MODE_LABELS,
  formatStatusText,
  type BotAccount,
  type GameModeId,
  type GuildInfo,
  type LogEntry,
  type NotificationItem,
  type PageId,
  type SavedAccountRow,
  type SquadInfo,
  type StatsResponse,
  type ToastItem,
  computeLevelProgress,
  ffAvatar,
  formatClock,
  formatDuration,
  normalizeCategory,
  normalizeGameMode,
  nowTimeStr,
} from './types';

const MUSIC_KEY = 'RDX_TEM_music_v4';
const COMPACT_KEY = 'RDX_TEM_compact_v4';
const NOTIF_KEY = 'RDX_TEM_notifs_v4';
const API_BASE_KEY = 'RDX_TEM_api_base_v4';

const PAGE_TITLES: Record<PageId, string> = {
  core: 'Core Dashboard',
  targets: 'Accounts',
  squad: 'My Squad',
  terminal: 'Live Console',
};

export default function App() {
  const [session, setSession] = useState<AuthSession | null>(() => getSavedSession());
  const [page, setPage] = useState<PageId>('core');
  const [apiBase, setApiBase] = useState<string>(() => {
    const saved = (localStorage.getItem(API_BASE_KEY) || '').trim().replace(/\/+$/, '');
    if (typeof window !== 'undefined' && window.location.protocol === 'https:' && saved.startsWith('http://')) {
      localStorage.removeItem(API_BASE_KEY);
      return '';
    }
    return saved;
  });

  const [accounts, setAccounts] = useState<BotAccount[]>([]);
  const [guilds, setGuilds] = useState<GuildInfo[]>([]);
  const [squads, setSquads] = useState<SquadInfo[]>([]);
  const [creatingBots, setCreatingBots] = useState<boolean>(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [totalMatches, setTotalMatches] = useState(0);
  const [matchesStarted, setMatchesStarted] = useState(0);
  const [activeMatches, setActiveMatches] = useState(0);
  const [totalGainedExp, setTotalGainedExp] = useState(0);
  const [expPerHour, setExpPerHour] = useState(0);
  const [teamCode, setTeamCode] = useState<string | null>(null);
  const [serverUptime, setServerUptime] = useState<number>(0);
  const [engineOnline, setEngineOnline] = useState<boolean>(false);
  const [syncing, setSyncing] = useState<boolean>(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'in_match' | 'online' | 'paused'>('all');
  const [logFilter, setLogFilter] = useState<'all' | 'match' | 'success' | 'error'>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const [compactMode, setCompactMode] = useState(() => sessionStorage.getItem(COMPACT_KEY) === '1');

  const [addOpen, setAddOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [engineOpen, setEngineOpen] = useState(false);
  const [clearAllOpen, setClearAllOpen] = useState(false);
  const [confirmState, setConfirmState] = useState<{ open: boolean; uid: string; authUid?: string }>({
    open: false,
    uid: '',
  });
  const [notifOpen, setNotifOpen] = useState(false);

  const [cloudUserId, setCloudUserId] = useState<string | null>(() =>
    auth.currentUser && auth.currentUser.emailVerified ? auth.currentUser.uid : null,
  );
  const cloudSyncedOnceRef = useRef<boolean>(false);
  const cloudKnownGuildsRef = useRef<Set<string>>(new Set());
  const cloudKnownSquadsRef = useRef<Set<string>>(new Set());
  const cloudKnownAccountsRef = useRef<Set<string>>(new Set());
  const guildSigRef = useRef<Map<string, string>>(new Map());
  const squadSigRef = useRef<Map<string, string>>(new Map());
  const accountSigRef = useRef<Map<string, string>>(new Map());
  const cloudRestoringRef = useRef<boolean>(false);

  const [notifications, setNotifications] = useState<NotificationItem[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(NOTIF_KEY) || '[]');
    } catch {
      return [];
    }
  });
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const [musicOn, setMusicOn] = useState(() => sessionStorage.getItem(MUSIC_KEY) === '1');
  const audioCtxRef = useRef<AudioContext | null>(null);
  const musicNodesRef = useRef<{
    master: GainNode;
    oscillators: OscillatorNode[];
    lfo: OscillatorNode;
  } | null>(null);
  const consoleRef = useRef<HTMLDivElement | null>(null);

  const beep = useCallback((freq = 800, dur = 0.06, type: OscillatorType = 'sine', vol = 0.03) => {
    try {
      if (!audioCtxRef.current) {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        audioCtxRef.current = new AudioCtx();
      }
      const ctx = audioCtxRef.current;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = freq;
      o.type = type;
      g.gain.value = vol;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      o.stop(ctx.currentTime + dur);
    } catch {
      // Ignore audio errors when autoplay policy blocks before user gesture
    }
  }, []);

  const soundSuccess = useCallback(() => {
    beep(700, 0.08, 'sine', 0.035);
    setTimeout(() => beep(1080, 0.1, 'sine', 0.035), 80);
  }, [beep]);

  const soundError = useCallback(() => {
    beep(290, 0.14, 'sawtooth', 0.035);
  }, [beep]);

  const stopAmbientMusic = useCallback(() => {
    const nodes = musicNodesRef.current;
    if (!nodes) return;
    try {
      nodes.oscillators.forEach((o) => o.stop());
      nodes.lfo.stop();
      nodes.master.disconnect();
    } catch {
      // Ignore stop errors
    }
    musicNodesRef.current = null;
  }, []);

  const startAmbientMusic = useCallback(() => {
    if (musicNodesRef.current) return;
    try {
      if (!audioCtxRef.current) {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        audioCtxRef.current = new AudioCtx();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume();
      const master = ctx.createGain();
      master.gain.value = 0.035;
      master.connect(ctx.destination);
      const freqs = [110, 164.81, 220];
      const filters: BiquadFilterNode[] = [];
      const oscillators = freqs.map((freq, idx) => {
        const o = ctx.createOscillator();
        o.type = idx === 0 ? 'sawtooth' : 'sine';
        o.frequency.value = freq;
        o.detune.value = (idx - 1) * 4;
        const g = ctx.createGain();
        g.gain.value = idx === 0 ? 0.14 : 0.24;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 760;
        filter.Q.value = 2.8;
        o.connect(filter);
        filter.connect(g);
        g.connect(master);
        o.start();
        filters.push(filter);
        return o;
      });
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.08;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 260;
      lfo.connect(lfoGain);
      filters.forEach((f) => lfoGain.connect(f.frequency));
      lfo.start();
      musicNodesRef.current = { master, oscillators, lfo };
    } catch {
      // Ignore audio errors
    }
  }, []);

  const addToast = useCallback(
    (message: string, type: ToastItem['type'] = 'info') => {
      const id = `${Date.now()}_${Math.random()}`;
      setToasts((prev) => [...prev.slice(-3), { id, message, type }]);
      if (type === 'success') soundSuccess();
      if (type === 'error') soundError();
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3400);
    },
    [soundError, soundSuccess]
  );

  const pushNotif = useCallback(
    (title: string, message: string, type: NotificationItem['type'] = 'info') => {
      setNotifications((prev) => {
        const next: NotificationItem[] = [
          {
            id: `${Date.now()}_${Math.random()}`,
            title,
            message,
            type,
            time: nowTimeStr(),
            read: false,
          },
          ...prev,
        ].slice(0, 50);
        try {
          sessionStorage.setItem(NOTIF_KEY, JSON.stringify(next));
        } catch {
          // Ignore storage quota errors
        }
        return next;
      });
    },
    []
  );

  const fetchWithFallback = useCallback(
    async (path: string, init?: RequestInit) => {
      if (!apiBase) {
        return fetch(path, init);
      }
      try {
        const res = await fetch(`${apiBase}${path}`, init);
        const contentType = res.headers.get('content-type') || '';
        if (res.ok && contentType.includes('application/json')) {
          return res;
        }
        throw new Error(`HTTP ${res.status}`);
      } catch (primaryErr) {
        try {
          const fallbackRes = await fetch(path, init);
          const fallbackCt = fallbackRes.headers.get('content-type') || '';
          if (fallbackRes.ok && fallbackCt.includes('application/json')) {
            setApiBase('');
            localStorage.removeItem(API_BASE_KEY);
            return fallbackRes;
          }
        } catch {
          // Ignore same-origin probe failure and surface original error
        }
        throw primaryErr;
      }
    },
    [apiBase]
  );

  const reconcileCloudWorkspace = useCallback(
    async (
      userId: string,
      nextGuilds: GuildInfo[],
      nextSquads: SquadInfo[],
      savedAccounts: SavedAccountRow[],
      deletedUids: string[],
    ) => {
      if (cloudRestoringRef.current) return;

      for (const delId of deletedUids) {
        if (cloudKnownAccountsRef.current.has(delId)) {
          cloudKnownAccountsRef.current.delete(delId);
          accountSigRef.current.delete(delId);
          void removeAccountDoc(userId, delId);
        }
      }

      for (const g of nextGuilds) {
        const sig = `${g.name}|${g.region}|${g.verified}|${g.duration_days}|${g.duration_hours}|${g.duration_minutes}|${g.expires_at}|${g.is_paused}`;
        if (guildSigRef.current.get(g.clan_id) !== sig) {
          guildSigRef.current.set(g.clan_id, sig);
          const exists = cloudKnownGuildsRef.current.has(g.clan_id);
          cloudKnownGuildsRef.current.add(g.clan_id);
          void upsertGuildDoc(userId, g, exists);
        }
      }

      for (const sq of nextSquads) {
        const sig = `${sq.clan_id}|${sq.name}|${sq.target_size}|${sq.game_mode}|${sq.lobby_delay_sec}|${sq.bot_prefix}|${sq.is_paused}`;
        if (squadSigRef.current.get(sq.id) !== sig) {
          squadSigRef.current.set(sq.id, sig);
          const exists = cloudKnownSquadsRef.current.has(sq.id);
          cloudKnownSquadsRef.current.add(sq.id);
          void upsertSquadDoc(userId, sq, exists);
        }
      }

      for (const acc of savedAccounts) {
        const sig = `${acc.password}|${acc.region}|${acc.clan_id}|${acc.squad_id || ''}|${acc.bot_prefix || ''}|${acc.nickname || ''}|${acc.max_matches || 0}|${acc.max_hours || 0}`;
        if (accountSigRef.current.get(acc.uid) !== sig) {
          accountSigRef.current.set(acc.uid, sig);
          const exists = cloudKnownAccountsRef.current.has(acc.uid);
          cloudKnownAccountsRef.current.add(acc.uid);
          void upsertAccountDoc(userId, acc, exists);
        }
      }
    },
    [],
  );

  const fetchStats = useCallback(
    async (manual = false) => {
      if (manual) setSyncing(true);
      try {
        const res = await fetchWithFallback('/api/stats', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) throw new Error('Non-JSON response');
        const data = (await res.json()) as StatsResponse;
        const nextAccounts = Array.isArray(data.accounts) ? data.accounts : [];
        const nextGuilds = Array.isArray(data.guilds) ? data.guilds : [];
        const nextSquads = Array.isArray(data.squads) ? data.squads : [];
        const nextSaved = Array.isArray(data.saved_accounts) ? data.saved_accounts : [];
        const nextDeleted = Array.isArray(data.deleted_uids) ? data.deleted_uids : [];

        setAccounts(nextAccounts);
        setGuilds(nextGuilds);
        setSquads(nextSquads);
        setCreatingBots(Boolean(data.creating));
        setLogs(Array.isArray(data.logs) ? data.logs : []);
        setTotalMatches(data.total_matches || 0);
        setMatchesStarted(data.total_matches_started || 0);
        setActiveMatches(data.total_active_matches || 0);
        setTotalGainedExp(data.total_gained_exp || 0);
        setExpPerHour(data.exp_per_hour || 0);
        setTeamCode(data.team_code || null);
        if (typeof data.uptime === 'number') setServerUptime(data.uptime);
        setEngineOnline(true);

        if (cloudUserId && cloudSyncedOnceRef.current) {
          void reconcileCloudWorkspace(cloudUserId, nextGuilds, nextSquads, nextSaved, nextDeleted);
        }

        if (manual) addToast('Synced with RDX Engine', 'success');
      } catch {
        setEngineOnline(false);
        if (manual) {
          addToast('Engine offline — check server or endpoint settings', 'error');
        }
      } finally {
        setSyncing(false);
      }
    },
    [addToast, cloudUserId, fetchWithFallback, reconcileCloudWorkspace],
  );

  const fetchStatsRef = useRef(fetchStats);
  fetchStatsRef.current = fetchStats;
  const sessionEmailRef = useRef<string | null>(session?.email ?? null);
  sessionEmailRef.current = session?.email ?? null;
  const hasSession = Boolean(session);

  useEffect(() => {
    void testConnection();
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      if (fbUser && fbUser.emailVerified) {
        setCloudUserId(fbUser.uid);
        try {
          const idToken = await fbUser.getIdToken();
          const restored: AuthSession = {
            email: fbUser.email || 'operator@rdx.local',
            localId: fbUser.uid,
            idToken,
            expiresAt: Date.now() + 50 * 60 * 1000,
            cloudEnabled: true,
          };
          sessionStorage.setItem(SESSION_KEY, JSON.stringify(restored));
          setSession((prev) => prev ?? restored);
        } catch {
          // ignore token restore failure
        }
      } else {
        setCloudUserId(null);
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!cloudUserId || !hasSession) return;
    let cancelled = false;
    cloudRestoringRef.current = true;
    cloudSyncedOnceRef.current = false;
    cloudKnownGuildsRef.current.clear();
    cloudKnownSquadsRef.current.clear();
    cloudKnownAccountsRef.current.clear();
    guildSigRef.current.clear();
    squadSigRef.current.clear();
    accountSigRef.current.clear();

    (async () => {
      try {
        const email = auth.currentUser?.email || sessionEmailRef.current || 'operator@rdx.local';
        await ensureUserProfileDoc(cloudUserId, email, auth.currentUser?.displayName);
        const ws = await loadUserWorkspace(cloudUserId);
        if (cancelled) return;

        for (const g of ws.guilds) {
          if (g.clan_id) cloudKnownGuildsRef.current.add(g.clan_id);
        }
        for (const s of ws.squads) {
          if (s.id) cloudKnownSquadsRef.current.add(s.id);
        }
        for (const a of ws.accounts) {
          if (a.uid) cloudKnownAccountsRef.current.add(a.uid);
        }

        if (ws.guilds.length > 0 || ws.squads.length > 0 || ws.accounts.length > 0) {
          const syncRes = await fetchWithFallback('/api/workspace/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ws),
          });
          const syncData = await syncRes.json().catch(() => ({}));
          const restoredTotal =
            Number(syncData.restoredGuilds || 0) +
            Number(syncData.restoredSquads || 0) +
            Number(syncData.restoredAccounts || 0);
          if (restoredTotal > 0) {
            addToast(
              `Restored ${syncData.restoredGuilds || 0} guild(s), ${syncData.restoredSquads || 0} squad(s), ${syncData.restoredAccounts || 0} bot(s) from Cloud`,
              'success',
            );
          }
        }
      } catch {
        // Ignore offline/initial sync failure
      } finally {
        if (!cancelled) {
          cloudRestoringRef.current = false;
          cloudSyncedOnceRef.current = true;
          void fetchStatsRef.current(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [addToast, cloudUserId, fetchWithFallback, hasSession]);

  const hasActiveMatchCountdown = squads.some(
    (squad) => squad.in_match_count > 0 || Number(squad.next_match_at) > Date.now(),
  );

  useEffect(() => {
    if (!session) return;
    fetchStats(false);
    const pollIntervalMs = hasActiveMatchCountdown ? 1000 : 4000;
    const poll = setInterval(() => {
      if (!document.hidden) fetchStats(false);
    }, pollIntervalMs);
    return () => clearInterval(poll);
  }, [fetchStats, hasActiveMatchCountdown, session]);

  useEffect(() => {
    if (!session) return;
    const tick = setInterval(() => {
      setServerUptime((u) => u + 1);
      setAccounts((prev) =>
        prev.map((a) =>
          ['online', 'match', 'search'].includes(normalizeCategory(a))
            ? {
                ...a,
                uptime_seconds: (a.uptime_seconds || 0) + 1,
              }
            : a
        )
      );
    }, 1000);
    return () => clearInterval(tick);
  }, [session]);

  useEffect(() => {
    if (autoScroll && page === 'terminal' && consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [logs, autoScroll, page, logFilter]);

  const handleToggleMusic = () => {
    const next = !musicOn;
    setMusicOn(next);
    sessionStorage.setItem(MUSIC_KEY, next ? '1' : '0');
    if (next) startAmbientMusic();
    else stopAmbientMusic();
    addToast(next ? 'Ambient music enabled' : 'Music muted', 'info');
  };

  const handleToggleCompact = () => {
    const next = !compactMode;
    setCompactMode(next);
    sessionStorage.setItem(COMPACT_KEY, next ? '1' : '0');
    addToast(next ? 'Compact mode enabled' : 'Normal mode enabled', 'info');
  };

  const handleLogout = () => {
    stopAmbientMusic();
    sessionStorage.removeItem(SESSION_KEY);
    cloudKnownGuildsRef.current.clear();
    cloudKnownSquadsRef.current.clear();
    cloudKnownAccountsRef.current.clear();
    guildSigRef.current.clear();
    squadSigRef.current.clear();
    accountSigRef.current.clear();
    cloudSyncedOnceRef.current = false;
    setCloudUserId(null);
    void signOut(auth);
    setSession(null);
  };

  const handleConnectCloudSync = async () => {
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      if (cred.user && cred.user.emailVerified) {
        const idToken = await cred.user.getIdToken();
        const nextSession: AuthSession = {
          email: cred.user.email || session?.email || 'operator@rdx.local',
          localId: cred.user.uid,
          idToken,
          expiresAt: Date.now() + 50 * 60 * 1000,
          cloudEnabled: true,
        };
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
        setSession(nextSession);
        setCloudUserId(cred.user.uid);
        addToast('Cloud Backup connected with Google', 'success');
      }
    } catch {
      addToast('Google Cloud Sync cancelled', 'info');
    }
  };

  const postApi = async (path: string, body?: unknown) => {
    const res = await fetchWithFallback(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };

  const handleAddAccount = async (payload: {
    uid?: string;
    password?: string;
    token?: string;
    clan_id?: string;
    squad_id?: string;
  }) => {
    if (!payload.token && (!payload.uid || !payload.password)) {
      addToast('UID and Password (or Access Token) are required', 'error');
      return;
    }
    try {
      const data = await postApi('/api/account/add', payload);
      if (data.status === 'ok') {
        setAddOpen(false);
        addToast('Account added to RDX Engine', 'success');
        pushNotif('Account Added', `Started ${payload.uid || 'token account'} on BD`, 'success');
        fetchStats(false);
      } else {
        addToast(data.error || 'Failed to add account', 'error');
      }
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : 'Unable to reach RDX Engine API';
      addToast(msg, 'error');
    }
  };

  const handleCreateTeam = async (payload: {
    region: string;
    clan_id: string;
    squad_id?: string;
    squad_name?: string;
    game_mode: GameModeId;
    lobby_delay_sec: number;
    bot_prefix: string;
    count: number;
    password: string;
  }) => {
    if (!payload.clan_id) {
      addToast('Clan ID is required', 'error');
      return;
    }
    try {
      const data = await postApi('/api/create_team', payload);
      if (data.ok) {
        setTeamOpen(false);
        const sqNames = Array.isArray(data.squads)
          ? data.squads.map((s: { name?: string }) => s.name).filter(Boolean).join(', ')
          : '';
        addToast(
          sqNames
            ? `Creating ${payload.count} bots -> ${sqNames} [${GAME_MODE_LABELS[payload.game_mode]}]`
            : `Creating ${payload.count} bots (${payload.bot_prefix}•)...`,
          'success',
        );
        pushNotif(
          'Create Team',
          `Launching ${payload.count} bots (${payload.bot_prefix}•) for Guild ${payload.clan_id}${sqNames ? ` (${sqNames})` : ''}`,
          'success',
        );
        setTimeout(() => fetchStats(false), 1500);
      } else {
        addToast(data.error || 'Failed to create team', 'error');
      }
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : 'Unable to reach RDX Engine API';
      addToast(msg, 'error');
    }
  };

  const handleTogglePause = async (uid: string) => {
    try {
      const data = await postApi('/api/account/pause', { uid });
      if (data.status === 'ok') {
        addToast(data.is_paused ? `Paused ${uid}` : `Resumed ${uid}`, data.is_paused ? 'info' : 'success');
        fetchStats(false);
      }
    } catch {
      addToast('Failed to reach engine', 'error');
    }
  };

  const handlePauseAll = async () => {
    try {
      const data = await postApi('/api/account/pause_all');
      if (data.status === 'ok') {
        addToast(data.all_paused ? 'All accounts paused' : 'All accounts resumed', 'info');
        fetchStats(false);
      }
    } catch {
      addToast('Failed to reach engine', 'error');
    }
  };

  const handleRestartAccount = async (uid: string) => {
    addToast(`Restarting ${uid}...`, 'info');
    try {
      await postApi('/api/account/restart', { uid });
      setTimeout(() => fetchStats(false), 900);
    } catch {
      addToast('Failed to reach engine', 'error');
    }
  };

  const handleRefreshAccount = async (uid: string) => {
    addToast(`Refreshing ${uid}...`, 'info');
    try {
      await postApi('/api/account/refresh', { uid });
      setTimeout(() => fetchStats(false), 900);
    } catch {
      addToast('Failed to reach engine', 'error');
    }
  };

  const handleConfirmDelete = async () => {
    const { uid, authUid } = confirmState;
    setConfirmState({ open: false, uid: '' });
    try {
      const data = await postApi('/api/account/delete', { uid, auth_uid: authUid || '' });
      if (data.status === 'ok') {
        if (cloudUserId) {
          cloudKnownAccountsRef.current.delete(uid);
          accountSigRef.current.delete(uid);
          void removeAccountDoc(cloudUserId, uid);
          if (authUid) {
            cloudKnownAccountsRef.current.delete(authUid);
            accountSigRef.current.delete(authUid);
            void removeAccountDoc(cloudUserId, authUid);
          }
        }
        addToast(`Removed ${uid}`, 'success');
        pushNotif('Account Deleted', `Removed UID ${uid}`, 'warning');
        fetchStats(false);
      }
    } catch {
      addToast('Failed to reach engine', 'error');
    }
  };

  const handleConfirmClearAll = async () => {
    setClearAllOpen(false);
    try {
      const data = await postApi('/api/accounts/clear_all');
      if (data.ok || data.status === 'ok') {
        if (cloudUserId) {
          cloudKnownAccountsRef.current.clear();
          accountSigRef.current.clear();
          await clearUserAccountDocs(cloudUserId);
        }
        addToast(`Cleared ${data.removed || 0} bot account(s)`, 'success');
        pushNotif('All Bots Cleared', `Removed ${data.removed || 0} bot account(s)`, 'warning');
        await fetchStats(false);
      }
    } catch {
      addToast('Failed to clear bot accounts', 'error');
    }
  };

  const handleClearLogs = async () => {
    try {
      await postApi('/api/logs/clear');
      setLogs([]);
      addToast('Console cleared', 'success');
    } catch {
      setLogs([]);
      addToast('Local console cleared', 'info');
    }
  };

  const handleCopyUid = async (uid: string, label = 'UID') => {
    try {
      await navigator.clipboard.writeText(uid);
      addToast(`Copied ${label}: ${uid}`, 'success');
    } catch {
      addToast(`${label}: ${uid}`, 'info');
    }
  };

  const handleLookupClan = async (clanId: string) => {
    try {
      const res = await fetchWithFallback(`/api/clan/lookup?clan_id=${encodeURIComponent(clanId)}`, {
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      return {
        found: Boolean(data.found),
        name: typeof data.name === 'string' ? data.name : undefined,
        region: typeof data.region === 'string' ? data.region : undefined,
      };
    } catch {
      return { found: false };
    }
  };

  const handleCreateGuild = async (payload: {
    clan_id: string;
    name?: string;
    days: number;
    hours: number;
    minutes: number;
  }) => {
    try {
      const data = await postApi('/api/guild/create', payload);
      if (data.ok) {
        addToast(`Guild ${data.guild?.name || payload.clan_id} created`, 'success');
        pushNotif('Guild Created', `${data.guild?.name || payload.clan_id} (${payload.clan_id})`, 'success');
        await fetchStats(false);
        return true;
      }
      addToast(data.error || 'Failed to create guild', 'error');
      return false;
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Unable to reach engine', 'error');
      return false;
    }
  };

  const handleUpdateGuild = async (payload: {
    clan_id: string;
    name?: string;
    days?: number;
    hours?: number;
    minutes?: number;
    is_paused?: boolean;
  }) => {
    try {
      const data = await postApi('/api/guild/update', payload);
      if (data.ok) {
        addToast('Guild updated', 'success');
        await fetchStats(false);
        return true;
      }
      addToast(data.error || 'Failed to update guild', 'error');
      return false;
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Unable to reach engine', 'error');
      return false;
    }
  };

  const handleDeleteGuild = async (clanId: string, deleteAccounts: boolean) => {
    try {
      const impactedSquads = squads.filter((s) => s.clan_id === clanId).map((s) => s.id);
      const impactedUids = deleteAccounts
        ? accounts.filter((a) => a.clan_id === clanId).map((a) => a.uid)
        : [];
      const data = await postApi('/api/guild/delete', { clan_id: clanId, delete_accounts: deleteAccounts });
      if (data.ok) {
        if (cloudUserId) {
          cloudKnownGuildsRef.current.delete(clanId);
          guildSigRef.current.delete(clanId);
          void removeGuildDoc(cloudUserId, clanId);
          for (const sid of impactedSquads) {
            cloudKnownSquadsRef.current.delete(sid);
            squadSigRef.current.delete(sid);
            void removeSquadDoc(cloudUserId, sid);
          }
          for (const uid of impactedUids) {
            cloudKnownAccountsRef.current.delete(uid);
            accountSigRef.current.delete(uid);
            void removeAccountDoc(cloudUserId, uid);
          }
        }
        addToast(`Guild ${clanId} deleted`, 'success');
        await fetchStats(false);
      }
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed to delete guild', 'error');
    }
  };

  const handleCreateSquad = async (payload: {
    clan_id: string;
    target_squad_id?: string;
    name?: string;
    target_size?: number;
    game_mode?: GameModeId;
    lobby_delay_sec?: number;
    bot_prefix?: string;
    mode: 'create_bots' | 'assign_existing';
    count?: number;
    password?: string;
    account_uids?: string[];
  }) => {
    try {
      const data = await postApi('/api/squad/create', payload);
      if (data.ok) {
        const createdCnt = Array.isArray(data.squads) ? data.squads.length : 1;
        addToast(
          payload.target_squad_id
            ? `Creating ${payload.count || 1} replacement bot(s) in squad...`
            : `Created ${createdCnt} squad(s) in guild ${payload.clan_id}`,
          'success',
        );
        pushNotif(
          payload.target_squad_id ? 'Bot Replenish' : 'Squad Created',
          payload.target_squad_id
            ? `Creating ${payload.count || 1} bot(s) for squad slot`
            : `Initialized ${createdCnt} isolated squad(s)`,
          'success',
        );
        await fetchStats(false);
        return true;
      }
      addToast(data.error || 'Failed to create squad', 'error');
      return false;
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Unable to reach engine', 'error');
      return false;
    }
  };

  const handleUpdateSquad = async (payload: {
    squad_id: string;
    name?: string;
    target_size?: number;
    game_mode?: GameModeId;
    lobby_delay_sec?: number;
    bot_prefix?: string;
    is_paused?: boolean;
    add_uids?: string[];
    remove_uids?: string[];
  }) => {
    try {
      const data = await postApi('/api/squad/update', payload);
      if (data.ok) {
        addToast('Squad updated', 'success');
        await fetchStats(false);
        return true;
      }
      addToast(data.error || 'Failed to update squad', 'error');
      return false;
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Unable to reach engine', 'error');
      return false;
    }
  };

  const handleRestartSquad = async (squadId: string) => {
    addToast('Restarting squad grouping...', 'info');
    try {
      await postApi('/api/squad/restart', { squad_id: squadId });
      await fetchStats(false);
    } catch {
      addToast('Failed to restart squad', 'error');
    }
  };

  const handleDeleteSquad = async (squadId: string, deleteAccounts: boolean) => {
    try {
      const impactedUids = deleteAccounts
        ? accounts.filter((a) => a.squad_id === squadId).map((a) => a.uid)
        : [];
      const data = await postApi('/api/squad/delete', { squad_id: squadId, delete_accounts: deleteAccounts });
      if (data.ok) {
        if (cloudUserId) {
          cloudKnownSquadsRef.current.delete(squadId);
          squadSigRef.current.delete(squadId);
          void removeSquadDoc(cloudUserId, squadId);
          for (const uid of impactedUids) {
            cloudKnownAccountsRef.current.delete(uid);
            accountSigRef.current.delete(uid);
            void removeAccountDoc(cloudUserId, uid);
          }
        }
        addToast('Squad removed', 'success');
        await fetchStats(false);
      }
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed to delete squad', 'error');
    }
  };

  const handleShare = async () => {
    const onlineCnt = accounts.filter((a) => ['online', 'match', 'search'].includes(normalizeCategory(a))).length;
    const matchCnt = accounts.filter((a) => normalizeCategory(a) === 'match').length;
    const text = `RDX TEM\nAccounts: ${accounts.length}\nOnline: ${onlineCnt}\nIn Match: ${matchCnt}\nTotal EXP: +${totalGainedExp.toLocaleString()}`;
    try {
      await navigator.clipboard.writeText(text);
      addToast('Status summary copied', 'success');
    } catch {
      addToast('Unable to copy summary', 'error');
    }
  };

  const counts = useMemo(() => {
    const res = { all: accounts.length, in_match: 0, online: 0, paused: 0, error: 0, idle: 0 };
    for (const acc of accounts) {
      const cat = normalizeCategory(acc);
      if (cat === 'match') {
        res.in_match += 1;
        res.online += 1;
      } else if (cat === 'online' || cat === 'search') {
        res.online += 1;
        res.idle += 1;
      } else if (cat === 'paused') {
        res.paused += 1;
      } else {
        res.error += 1;
      }
    }
    return res;
  }, [accounts]);

  const filteredAccounts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return accounts.filter((acc) => {
      const cat = normalizeCategory(acc);
      const matchesQ =
        !q ||
        String(acc.uid).toLowerCase().includes(q) ||
        String(acc.nickname || '').toLowerCase().includes(q);
      if (!matchesQ) return false;
      if (statusFilter === 'in_match') return cat === 'match';
      if (statusFilter === 'online') return cat === 'online' || cat === 'match' || cat === 'search';
      if (statusFilter === 'paused') return cat === 'paused';
      return true;
    });
  }, [accounts, searchQuery, statusFilter]);

  const filteredLogs = useMemo(() => {
    if (logFilter === 'match') {
      return logs.filter((l) => l.message.toLowerCase().includes('match'));
    }
    if (logFilter === 'success') {
      return logs.filter((l) => l.level === 'success' || l.message.includes('EXP'));
    }
    if (logFilter === 'error') {
      return logs.filter((l) => l.level === 'error' || l.level === 'warning');
    }
    return logs;
  }, [logs, logFilter]);

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications]
  );

  const upHours = Math.max(0.016, (serverUptime || 60) / 3600);
  const matchesPerHour = Math.round(matchesStarted / upHours);

  if (!session) {
    return (
      <div className="relative min-h-screen">
        <RdxBackground />
        <LoginEntry
          onAuthenticated={(s) => setSession(s)}
          onSoundError={soundError}
          onSoundSuccess={soundSuccess}
        />
      </div>
    );
  }

  return (
    <div className="relative h-screen flex overflow-hidden">
      <RdxBackground />

      {/* DESKTOP SIDEBAR */}
      <aside className="sidebar-premium relative z-20 hidden w-[264px] shrink-0 flex-col overflow-hidden border-r border-[rgba(239,68,68,0.14)] bg-[rgba(12,5,5,0.94)] px-3.5 py-5 backdrop-blur-xl lg:flex">
        <div aria-hidden="true" className="pointer-events-none absolute -left-28 -top-20 h-64 w-64 rounded-full bg-[#ef4444]/[0.08] blur-3xl" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-20 -right-32 h-64 w-64 rounded-full bg-[#14b8a6]/[0.06] blur-3xl" />
        <div aria-hidden="true" className="rdx-grid-bg pointer-events-none absolute inset-0 opacity-30" />

        <div className="relative mb-7 rounded-[18px] border border-white/[0.08] bg-gradient-to-br from-white/[0.045] to-transparent p-3 shadow-[0_14px_36px_rgba(0,0,0,0.18)]">
          <div aria-hidden="true" className="absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent via-[#ef4444]/75 to-transparent" />
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] border border-red-500/30 bg-gradient-to-br from-[#1e1515] to-[#100909] shadow-[0_0_24px_rgba(239,68,68,0.2)]">
              <RdxEmblem className="h-8 w-8" />
            </div>
            <div className="min-w-0">
              <b className="block bg-gradient-to-br from-[#ff8c8c] via-[#ef4444] to-[#b91c1c] bg-clip-text font-display text-[15px] font-extrabold tracking-[1px] text-transparent">
                RDX TEM
              </b>
              <small className="mt-0.5 block text-[9px] font-extrabold uppercase tracking-[1.25px] text-[#a8a29e]">
                Command Center
              </small>
            </div>
          </div>
        </div>

        <nav className="relative flex flex-1 flex-col gap-1.5">
          <div className="mb-1 px-3 text-[9px] font-extrabold uppercase tracking-[1.5px] text-[#706766]">
            Workspace
          </div>
          {(
            [
              { id: 'core', label: 'Core Dashboard', icon: Gauge },
              { id: 'targets', label: 'Accounts', icon: Network },
              { id: 'squad', label: 'My Squad', icon: Shield },
              { id: 'terminal', label: 'Live Console', icon: Terminal },
            ] as const
          ).map(({ id, label, icon: Icon }) => {
            const active = page === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setPage(id)}
                aria-current={active ? 'page' : undefined}
                className={`group relative flex w-full items-center gap-3 rounded-[14px] border px-2.5 py-2.5 text-left text-[12.5px] font-bold transition-all duration-200 cursor-pointer ${
                  active
                    ? 'border-[rgba(239,68,68,0.3)] bg-gradient-to-r from-[#ef4444]/[0.13] via-[#ef4444]/[0.06] to-[#14b8a6]/[0.06] text-[#f7f5f0] shadow-[0_8px_24px_rgba(239,68,68,0.1)]'
                    : 'border-transparent text-[#a8a29e] hover:border-white/[0.07] hover:bg-white/[0.035] hover:text-[#f7f5f0]'
                }`}
              >
                {active && (
                  <span className="absolute bottom-2.5 left-0 top-2.5 w-[3px] rounded-r bg-gradient-to-b from-[#ff8585] to-[#dc2626] shadow-[0_0_10px_rgba(239,68,68,0.6)]" />
                )}
                <span
                  className={`grid h-9 w-9 shrink-0 place-items-center rounded-[11px] border transition-all ${
                    active
                      ? 'border-[#ef4444]/20 bg-[#ef4444]/[0.1] text-[#ff8585]'
                      : 'border-white/[0.06] bg-white/[0.025] text-[#8f8886] group-hover:border-white/[0.1] group-hover:text-[#f7f5f0]'
                  }`}
                >
                  <Icon size={16} />
                </span>
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {active && <span className="h-1.5 w-1.5 rounded-full bg-[#ff7777] shadow-[0_0_9px_rgba(239,68,68,0.8)]" />}
              </button>
            );
          })}

        </nav>

        <div className="relative mt-5 border-t border-white/[0.07] pt-4">
          <div className="mb-3 rounded-[14px] border border-white/[0.07] bg-black/[0.22] p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2 text-[9px] font-extrabold uppercase tracking-[1px] text-[#a8a29e]">
                <Gauge size={12} className={engineOnline ? 'text-emerald-300' : 'text-amber-300'} />
                Engine Status
              </span>
              <span className={`inline-flex items-center gap-1.5 text-[9px] font-extrabold ${
                engineOnline ? 'text-emerald-300' : 'text-amber-300'
              }`}>
                <span className={`h-1.5 w-1.5 rounded-full ${
                  engineOnline ? 'bg-emerald-300 animate-sdot' : 'bg-amber-300'
                }`} />
                {engineOnline ? 'ONLINE' : 'OFFLINE'}
              </span>
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-[#8e8785]">
              {engineOnline ? 'Command engine connected and ready.' : 'Waiting for the command engine connection.'}
            </p>
            {teamCode && (
              <div className="mt-2 flex items-center justify-between gap-2 border-t border-white/[0.06] pt-2">
                <span className="text-[9px] font-bold uppercase tracking-[0.8px] text-[#706766]">Team Code</span>
                <span className="font-mono-num text-[10px] font-extrabold text-[#f7f5f0]">{teamCode}</span>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="group flex w-full items-center gap-3 rounded-[13px] border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-left text-[11px] font-extrabold text-[#a8a29e] transition-all hover:border-red-400/25 hover:bg-red-400/[0.06] hover:text-red-200 cursor-pointer"
          >
            <LogOut size={15} className="transition-transform group-hover:-translate-x-0.5" />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      {/* MAIN SHELL */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* TOPBAR */}
        <header className="flex items-center gap-2 px-4 sm:px-7 py-2.5 border-b border-[rgba(239,68,68,0.14)] bg-[rgba(15,0,0,0.88)] backdrop-blur-xl relative z-10 shrink-0">
          <div className="flex lg:hidden items-center gap-2.5 font-bold text-sm">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center border border-red-500/30 bg-[#161010]">
              <RdxEmblem className="w-6 h-6" />
            </div>
            <span className="font-display bg-gradient-to-br from-[#ef4444] to-[#dc2626] bg-clip-text text-transparent">
              RDX TEM
            </span>
          </div>

          <div className="hidden lg:flex items-center gap-2 text-[#a8a29e] font-bold text-[12.5px]">
            <span>Command Center</span>
            <ChevronRight size={12} className="opacity-60" />
            <b className="text-[#f7f5f0] font-extrabold">{PAGE_TITLES[page]}</b>
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleToggleMusic}
              title="Ambient Music"
              aria-label="Music"
              className={`w-9 h-9 rounded-[10px] border flex items-center justify-center transition-colors cursor-pointer ${
                musicOn
                  ? 'border-[#ef4444] bg-red-500/15 text-[#ef4444]'
                  : 'border-[rgba(239,68,68,0.14)] bg-[#1e1515] text-[#a8a29e] hover:text-[#ef4444]'
              }`}
            >
              {musicOn ? <Music size={15} /> : <VolumeX size={15} />}
            </button>

            <button
              type="button"
              onClick={() => setNotifOpen(true)}
              title="Notifications"
              aria-label="Notifications"
              className="relative w-9 h-9 rounded-[10px] border border-[rgba(239,68,68,0.14)] bg-[#1e1515] text-[#a8a29e] hover:text-[#ef4444] flex items-center justify-center cursor-pointer"
            >
              <Bell size={15} />
              {unreadCount > 0 && (
                <span className="absolute top-1 right-1 min-w-[15px] h-[15px] px-1 rounded-full bg-gradient-to-br from-[#ef4444] to-[#dc2626] text-[9px] font-black text-white grid place-items-center">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={handleToggleCompact}
              title="Compact Mode"
              aria-label="Compact"
              className={`hidden sm:flex w-9 h-9 rounded-[10px] border items-center justify-center cursor-pointer ${
                compactMode
                  ? 'border-[#ef4444] bg-red-500/15 text-[#ef4444]'
                  : 'border-[rgba(239,68,68,0.14)] bg-[#1e1515] text-[#a8a29e] hover:text-[#ef4444]'
              }`}
            >
              {compactMode ? <Maximize2 size={15} /> : <Minimize2 size={15} />}
            </button>

            <button
              type="button"
              onClick={handleShare}
              title="Copy Status Summary"
              aria-label="Share"
              className="hidden sm:flex w-9 h-9 rounded-[10px] border border-[rgba(239,68,68,0.14)] bg-[#1e1515] text-[#a8a29e] hover:text-[#ef4444] items-center justify-center cursor-pointer"
            >
              <Share2 size={15} />
            </button>

            <button
              type="button"
              onClick={() => fetchStats(true)}
              title="Sync"
              aria-label="Sync"
              className="w-9 h-9 rounded-[10px] border border-[rgba(239,68,68,0.14)] bg-[#1e1515] text-[#a8a29e] hover:text-[#ef4444] flex items-center justify-center cursor-pointer"
            >
              <RefreshCw size={15} className={syncing ? 'animate-spin text-[#ef4444]' : ''} />
            </button>

            <div
              className={`h-9 px-3 rounded-full border flex items-center gap-2 text-[10.5px] font-extrabold tracking-widest font-mono-num ${
                engineOnline
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                  : 'bg-red-500/10 border-red-500/30 text-[#ef4444]'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  engineOnline ? 'bg-emerald-400' : 'bg-[#ef4444]'
                }`}
              />
              <span className="hidden sm:inline">{engineOnline ? 'ONLINE' : 'OFFLINE'}</span>
            </div>
          </div>
        </header>

        {/* CONTENT VIEWPORT */}
        <main className="flex-1 overflow-y-auto p-5 sm:p-7 pb-24 lg:pb-8">
          <div className="max-w-[1240px] mx-auto">
            {/* CORE DASHBOARD */}
            {page === 'core' && (
              <section>
                <div className="flex flex-wrap items-end justify-between gap-4 mb-7">
                  <div>
                    <h1 className="font-display text-2xl sm:text-[28px] font-extrabold tracking-tight bg-gradient-to-br from-[#ef4444] via-[#f7f5f0] to-emerald-400 bg-clip-text text-transparent">
                      Core Dashboard
                    </h1>
                    <p className="text-[#a8a29e] text-[13.5px] font-medium mt-0.5">
                      Real-time system analytics · {session.email}
                      {cloudUserId ? ' · Cloud Sync Active' : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2.5">
                    {!cloudUserId && (
                      <button
                        type="button"
                        onClick={handleConnectCloudSync}
                        className="h-10 px-4 rounded-xl bg-[#161010] border border-[rgba(239,68,68,0.22)] hover:border-emerald-400 text-[#f7f5f0] text-[13px] font-bold inline-flex items-center gap-2 cursor-pointer"
                      >
                        <Cloud size={14} className="text-emerald-400" />
                        Connect Cloud Sync
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => fetchStats(true)}
                      className="h-10 px-4 rounded-xl bg-gradient-to-br from-[#ef4444] to-[#dc2626] text-[#f7f5f0] text-[13px] font-bold inline-flex items-center gap-2 shadow-[0_6px_20px_rgba(239,68,68,0.28)] cursor-pointer"
                    >
                      <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
                      Sync
                    </button>
                  </div>
                </div>

                {!engineOnline && (
                  <div className="mb-5 p-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3 text-xs sm:text-[13px]">
                      <TriangleAlert size={18} className="text-amber-400 shrink-0" />
                      <span>
                        Engine offline on{' '}
                        <code className="font-mono-num text-amber-300">{apiBase || window.location.origin}</code>. Clear
                        custom endpoint to use the built-in live server, or sync again.
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setEngineOpen(true)}
                      className="h-8 px-3 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-bold whitespace-nowrap cursor-pointer"
                    >
                      Endpoint Settings
                    </button>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3.5 mb-5">
                  {[
                    {
                      label: 'Active Accounts',
                      value: String(accounts.length),
                      foot: `${counts.online} Online`,
                      icon: Users,
                      color: 'text-[#ef4444]',
                    },
                    {
                      label: 'Matches Started',
                      value: String(matchesStarted),
                      foot: `~${matchesPerHour} / hr`,
                      icon: Rocket,
                      color: 'text-[#ef4444]',
                    },
                    {
                      label: 'Matches Completed',
                      value: String(totalMatches),
                      foot: `${activeMatches} Active`,
                      icon: Gamepad2,
                      color: 'text-[#ef4444]',
                    },
                    {
                      label: 'Total EXP',
                      value: `+${totalGainedExp.toLocaleString()}`,
                      foot: `~${expPerHour.toLocaleString()} EXP/hr`,
                      icon: Flame,
                      color: 'text-[#ef4444]',
                    },
                    {
                      label: 'Uptime',
                      value: formatClock(serverUptime),
                      foot: teamCode ? `Team Code: ${teamCode}` : 'Command Center Running',
                      icon: Clock,
                      color: 'text-[#ef4444]',
                    },
                  ].map((s) => (
                    <div
                      key={s.label}
                      className="rounded-2xl bg-[#161010] border border-[rgba(239,68,68,0.16)] p-5 hover:border-[rgba(239,68,68,0.38)] transition-all"
                    >
                      <div className="flex items-center gap-2.5 mb-3">
                        <div className="w-8 h-8 rounded-[9px] bg-[#1e1515] border border-[rgba(239,68,68,0.18)] grid place-items-center">
                          <s.icon size={15} className={s.color} />
                        </div>
                        <span className="text-[10.5px] font-bold uppercase tracking-[1px] text-[#a8a29e]">
                          {s.label}
                        </span>
                      </div>
                      <div className="font-mono-num text-[26px] font-bold tracking-tight leading-none mb-2">
                        {s.value}
                      </div>
                      <div className="font-mono-num text-xs font-semibold text-[#a8a29e]">{s.foot}</div>
                    </div>
                  ))}
                </div>

                <div className="relative isolate overflow-hidden rounded-[22px] border border-[rgba(239,68,68,0.18)] bg-gradient-to-br from-[#191313] via-[#141010] to-[#0d1110] p-5 mb-5 shadow-[0_18px_50px_rgba(0,0,0,0.24)]">
                  <div aria-hidden="true" className="pointer-events-none absolute -right-20 -top-28 h-64 w-64 rounded-full bg-[#14b8a6]/[0.07] blur-3xl" />
                  <div aria-hidden="true" className="pointer-events-none absolute -bottom-28 -left-16 h-52 w-52 rounded-full bg-[#ef4444]/[0.06] blur-3xl" />
                  <div aria-hidden="true" className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-[#14b8a6]/70 to-transparent" />

                  <div className="relative">
                    <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[#14b8a6]/20 bg-[#14b8a6]/[0.08] text-[#14b8a6] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
                          <Gauge size={18} />
                        </div>
                        <div className="min-w-0">
                          <h3 className="text-[13px] font-extrabold uppercase tracking-[1.2px] text-[#f7f5f0]">
                            Account Distribution
                          </h3>
                          <p className="text-xs text-[#a8a29e] mt-0.5">
                            Live worker allocation across match, lobby, paused, and error states
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[9px] font-extrabold tracking-[0.8px] ${
                            engineOnline
                              ? 'border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300'
                              : 'border-amber-400/25 bg-amber-400/[0.08] text-amber-300'
                          }`}
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              engineOnline ? 'bg-emerald-400 animate-sdot' : 'bg-amber-400'
                            }`}
                          />
                          {engineOnline ? 'ENGINE ONLINE' : 'ENGINE OFFLINE'}
                        </span>
                        <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 font-mono-num text-[10px] font-bold text-[#f7f5f0]">
                          {accounts.length} WORKERS
                        </span>
                      </div>
                    </div>

                    <div
                      role="img"
                      aria-label={`${accounts.length} accounts: ${counts.in_match} in match, ${counts.idle} online or in lobby, ${counts.paused} paused, ${counts.error} offline or in error`}
                      className="mb-4 flex h-3 overflow-hidden rounded-full border border-white/[0.08] bg-[#090707] p-[2px] shadow-[inset_0_2px_5px_rgba(0,0,0,0.55)]"
                    >
                      {accounts.length > 0 && (
                        <>
                          {counts.in_match > 0 && (
                            <span
                              title={`In Match: ${counts.in_match}`}
                              className="h-full rounded-full bg-gradient-to-r from-[#0f9f92] to-[#2dd4bf] transition-all duration-700"
                              style={{ width: `${(counts.in_match / accounts.length) * 100}%` }}
                            />
                          )}
                          {counts.idle > 0 && (
                            <span
                              title={`Online / Lobby: ${counts.idle}`}
                              className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-300 transition-all duration-700"
                              style={{ width: `${(counts.idle / accounts.length) * 100}%` }}
                            />
                          )}
                          {counts.paused > 0 && (
                            <span
                              title={`Paused: ${counts.paused}`}
                              className="h-full rounded-full bg-gradient-to-r from-amber-600 to-amber-300 transition-all duration-700"
                              style={{ width: `${(counts.paused / accounts.length) * 100}%` }}
                            />
                          )}
                          {counts.error > 0 && (
                            <span
                              title={`Offline / Error: ${counts.error}`}
                              className="h-full rounded-full bg-gradient-to-r from-red-700 to-red-400 transition-all duration-700"
                              style={{ width: `${(counts.error / accounts.length) * 100}%` }}
                            />
                          )}
                        </>
                      )}
                    </div>

                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
                      {[
                        {
                          label: 'In Match',
                          sub: 'Active combat loop',
                          val: counts.in_match,
                          dot: 'bg-[#14b8a6]',
                          valClass: 'text-[#5eead4]',
                          icon: Crosshair,
                        },
                        {
                          label: 'Online / Lobby',
                          sub: 'Ready & searching',
                          val: counts.idle,
                          dot: 'bg-emerald-400',
                          valClass: 'text-emerald-300',
                          icon: Globe,
                        },
                        {
                          label: 'Paused',
                          sub: 'Held by operator/timer',
                          val: counts.paused,
                          dot: 'bg-amber-400',
                          valClass: 'text-amber-300',
                          icon: Pause,
                        },
                        {
                          label: 'Offline / Error',
                          sub: 'Reconnecting / replacing',
                          val: counts.error,
                          dot: 'bg-[#ef4444]',
                          valClass: 'text-red-300',
                          icon: TriangleAlert,
                        },
                      ].map((row) => {
                        const pct = accounts.length > 0 ? Math.round((row.val / accounts.length) * 100) : 0;
                        return (
                          <div
                            key={row.label}
                            className="min-w-0 rounded-[14px] border border-white/[0.07] bg-black/[0.18] p-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-white/[0.14] hover:bg-white/[0.035]"
                          >
                            <div className="mb-2 flex items-center justify-between gap-2">
                              <div className="flex min-w-0 items-center gap-2 text-[10px] font-bold text-[#c8c2bd]">
                                <span className={`h-2 w-2 shrink-0 rounded-full ${row.dot} ${row.val > 0 ? 'account-distribution-dot-active' : ''}`} />
                                <span className="truncate">{row.label}</span>
                              </div>
                              <row.icon size={14} className={`${row.valClass} shrink-0 opacity-80`} />
                            </div>
                            <div className="flex items-baseline gap-2">
                              <span className={`font-mono-num text-[25px] font-extrabold leading-none ${row.valClass}`}>
                                {row.val}
                              </span>
                              <span className="font-mono-num text-[10px] font-bold text-[#a8a29e]">{pct}%</span>
                            </div>
                            <div className="mt-1 text-[10px] text-[#a8a29e]/80">{row.sub}</div>
                            <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.05]">
                              <span
                                className={`block h-full rounded-full ${row.dot} transition-all duration-700`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* ACTIVE SQUADS OVERVIEW */}
                <div className="relative isolate overflow-hidden rounded-[22px] border border-[rgba(239,68,68,0.18)] bg-gradient-to-br from-[#191313] via-[#141010] to-[#0d1110] p-5 shadow-[0_18px_50px_rgba(0,0,0,0.24)]">
                  <div aria-hidden="true" className="pointer-events-none absolute -right-20 -top-28 h-64 w-64 rounded-full bg-[#14b8a6]/[0.07] blur-3xl" />
                  <div aria-hidden="true" className="pointer-events-none absolute -bottom-28 -left-16 h-52 w-52 rounded-full bg-[#ef4444]/[0.06] blur-3xl" />
                  <div aria-hidden="true" className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-[#ef4444]/70 to-transparent" />

                  <div className="relative">
                    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[#ef4444]/20 bg-[#ef4444]/[0.08] text-[#ef7777] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
                          <Shield size={18} />
                        </div>
                        <div className="min-w-0">
                          <h3 className="text-[13px] font-extrabold uppercase tracking-[1.2px] text-[#f7f5f0]">
                            Active Squads Overview
                          </h3>
                          <p className="mt-0.5 text-xs text-[#a8a29e]">
                            {guilds.length} Guild(s) <span className="mx-1 text-[#ef4444]/70">·</span>{' '}
                            {squads.length} Isolated Squad(s)
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setPage('squad')}
                        className="inline-flex h-9 items-center gap-2 rounded-xl border border-[#ef4444]/25 bg-[#ef4444]/[0.08] px-3 text-[11px] font-extrabold text-[#ff8585] transition-all hover:-translate-y-0.5 hover:border-[#ef4444]/50 hover:bg-[#ef4444]/[0.14] hover:shadow-[0_8px_24px_rgba(239,68,68,0.12)]"
                      >
                        Manage Squads <ChevronRight size={14} />
                      </button>
                    </div>

                    {squads.length === 0 ? (
                      <div className="rounded-[16px] border border-dashed border-white/[0.12] bg-black/[0.15] px-4 py-8 text-center">
                        <Users size={24} className="mx-auto mb-2 text-[#a8a29e]/70" />
                        <p className="text-xs text-[#a8a29e]">
                          No squads active yet. Open <strong className="text-[#f7f5f0]">My Squad</strong> to launch a guild squad.
                        </p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] gap-3 border-t border-white/[0.07] pt-4">
                        {squads.map((sq) => {
                          const statusColor =
                            sq.status === 'IN MATCH'
                              ? 'text-[#5eead4] border-[#14b8a6]/30 bg-[#14b8a6]/[0.08]'
                              : sq.status === 'PAUSED'
                              ? 'text-amber-300 border-amber-400/25 bg-amber-400/[0.07]'
                              : sq.status === 'SEARCHING' || sq.status === 'SQUAD READY'
                              ? 'text-emerald-300 border-emerald-400/25 bg-emerald-400/[0.07]'
                              : 'text-[#c8c2bd] border-white/[0.1] bg-white/[0.04]';
                          const groupedCount = Math.max(0, Number(sq.in_squad_count) || 0);
                          const targetSize = Math.max(1, Number(sq.target_size) || 1);
                          const groupedPct = Math.min(100, (groupedCount / targetSize) * 100);
                          const squadStatus = formatStatusText(sq.status, normalizeGameMode(sq.game_mode));

                          return (
                            <div
                              key={sq.id}
                              className="group relative overflow-hidden rounded-[17px] border border-white/[0.08] bg-black/[0.2] p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-white/[0.15] hover:bg-black/[0.28] hover:shadow-[0_14px_34px_rgba(0,0,0,0.2)]"
                            >
                              <div aria-hidden="true" className="pointer-events-none absolute -right-10 -top-12 h-32 w-32 rounded-full bg-[#14b8a6]/[0.06] blur-2xl transition-opacity group-hover:opacity-100" />
                              <div className="relative">
                                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                                  <button
                                    type="button"
                                    onClick={() => setPage('squad')}
                                    className="flex min-w-0 items-center gap-3 text-left"
                                  >
                                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-[#f7f5f0]">
                                      <Users size={17} />
                                    </span>
                                    <span className="min-w-0">
                                      <span className="block truncate text-sm font-extrabold text-[#f7f5f0] transition-colors group-hover:text-white">
                                        {sq.name}
                                      </span>
                                      <span className="mt-0.5 block truncate text-[10px] font-medium text-[#a8a29e]">
                                        <Shield size={10} className="mr-1 inline-block text-[#ef7777]" />
                                        {sq.clan_name || 'No guild assigned'}
                                      </span>
                                    </span>
                                  </button>
                                  <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[9px] font-extrabold tracking-[0.3px] ${statusColor}`}>
                                    <span className={`h-1.5 w-1.5 rounded-full bg-current ${
                                      ['IN MATCH', 'SEARCHING', 'SQUAD READY'].includes(sq.status)
                                        ? 'account-distribution-dot-active'
                                        : ''
                                    }`} />
                                    {squadStatus}
                                  </span>
                                </div>

                                <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                                  <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-2.5">
                                    <div className="mb-1.5 flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.7px] text-[#a8a29e]">
                                      <Gamepad2 size={12} className="text-[#ef7777]" /> Mode
                                    </div>
                                    <div className="truncate text-[11px] font-bold text-[#f7f5f0]">
                                      {GAME_MODE_LABELS[normalizeGameMode(sq.game_mode)]}
                                    </div>
                                  </div>
                                  <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-2.5">
                                    <div className="mb-1.5 flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.7px] text-[#a8a29e]">
                                      <Flame size={12} className="text-amber-300" /> Match Cycle
                                    </div>
                                    <div className="truncate text-[11px] font-bold text-[#f7f5f0]">
                                      {sq.completed_matches_in_cycle}/{sq.match_reset_threshold} matches
                                    </div>
                                  </div>
                                  <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-2.5">
                                    <div className="mb-1.5 flex items-center justify-between gap-2 text-[9px] font-bold uppercase tracking-[0.7px] text-[#a8a29e]">
                                      <span className="inline-flex items-center gap-1.5">
                                        <Users size={12} className="text-[#5eead4]" /> In Squad
                                      </span>
                                      <span className="font-mono-num text-[10px] font-extrabold text-[#5eead4]">
                                        {groupedCount}/{targetSize}
                                      </span>
                                    </div>
                                    <div
                                      role="progressbar"
                                      aria-label={`${sq.name} grouped players`}
                                      aria-valuemin={0}
                                      aria-valuemax={targetSize}
                                      aria-valuenow={Math.min(groupedCount, targetSize)}
                                      className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]"
                                    >
                                      <span
                                        className="block h-full rounded-full bg-gradient-to-r from-[#0f9f92] to-[#5eead4] transition-all duration-500"
                                        style={{ width: `${groupedPct}%` }}
                                      />
                                    </div>
                                  </div>
                                  <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-2.5">
                                    <div className="mb-1.5 flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.7px] text-[#a8a29e]">
                                      <Network size={12} className="text-[#ef7777]" /> Team Code
                                    </div>
                                    <div className={`truncate font-mono-num text-[11px] font-extrabold ${
                                      sq.team_code ? 'text-[#f7f5f0]' : 'text-[#a8a29e]'
                                    }`}>
                                      {sq.team_code || 'Waiting for code'}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </section>
            )}

            {/* ACCOUNTS PAGE */}
            {page === 'targets' && (
              <section>
                <div className="flex flex-wrap items-end justify-between gap-3.5 mb-6">
                  <div>
                    <h1 className="font-display text-[26px] sm:text-[32px] font-black tracking-[-0.5px] bg-gradient-to-br from-[#ef4444] to-[#dc2626] bg-clip-text text-transparent">
                      Accounts
                    </h1>
                    <p className="text-[#a8a29e] text-[12.5px] font-semibold mt-0.5 tracking-[0.2px]">
                      Manage connected accounts · Banned bots auto-replaced automatically
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2.5">
                    <button
                      type="button"
                      disabled={accounts.length === 0}
                      onClick={() => setClearAllOpen(true)}
                      className="min-h-[42px] px-[16px] rounded-[12px] bg-red-500/10 border border-red-500/35 hover:bg-red-500/20 text-[#ef4444] text-[12.5px] font-extrabold inline-flex items-center gap-2 transition-all cursor-pointer disabled:opacity-45"
                    >
                      <Trash2 size={13} />
                      Clear All
                    </button>
                    <button
                      type="button"
                      onClick={handlePauseAll}
                      className="min-h-[42px] px-[18px] rounded-[12px] bg-[rgba(30,21,21,0.6)] border border-[rgba(239,68,68,0.16)] hover:border-[rgba(239,68,68,0.38)] hover:bg-[rgba(40,28,28,0.9)] hover:-translate-y-0.5 text-[#f7f5f0] text-[12.5px] font-extrabold inline-flex items-center gap-2 transition-all cursor-pointer"
                    >
                      <Pause size={13} />
                      Pause All
                    </button>
                    <button
                      type="button"
                      onClick={() => setTeamOpen(true)}
                      className="min-h-[42px] px-[18px] rounded-[12px] bg-gradient-to-br from-[#10b981] to-[#34d399] text-[#080000] text-[12.5px] font-extrabold inline-flex items-center gap-2 shadow-[0_10px_28px_rgba(16,185,129,0.35)] hover:shadow-[0_14px_36px_rgba(16,185,129,0.48)] hover:-translate-y-0.5 transition-all cursor-pointer"
                    >
                      <Users size={13} />
                      Create Team
                    </button>
                    <button
                      type="button"
                      onClick={() => setAddOpen(true)}
                      className="min-h-[42px] px-[18px] rounded-[12px] bg-gradient-to-br from-[#ef4444] to-[#dc2626] text-[#080000] text-[12.5px] font-extrabold inline-flex items-center gap-2 shadow-[0_10px_28px_rgba(239,68,68,0.35),inset_0_1px_0_rgba(255,255,255,0.3)] hover:shadow-[0_14px_38px_rgba(239,68,68,0.5)] hover:-translate-y-0.5 transition-all cursor-pointer"
                    >
                      <Plus size={14} strokeWidth={2.6} />
                      Add Account
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 mb-5">
                  <div className="relative flex-1 min-w-[220px]">
                    <Search
                      size={14}
                      className="absolute left-4 top-1/2 -translate-y-1/2 text-[#a8a29e] pointer-events-none"
                    />
                    <input
                      type="search"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search by name or UID..."
                      className="w-full h-[44px] pl-11 pr-4 rounded-[12px] bg-[rgba(22,16,16,0.62)] border border-[rgba(239,68,68,0.16)] text-[13px] font-semibold placeholder:text-[#a8a29e] outline-none transition-all focus:border-[#ef4444] focus:shadow-[0_0_0_3px_rgba(239,68,68,0.15),0_0_20px_rgba(239,68,68,0.1)]"
                    />
                  </div>

                  <div className="inline-flex flex-wrap gap-1 p-1 rounded-[12px] bg-[rgba(22,16,16,0.62)] border border-[rgba(239,68,68,0.16)]">
                    {(
                      [
                        { id: 'all', label: 'All', cnt: counts.all },
                        { id: 'in_match', label: 'In Match', cnt: counts.in_match },
                        { id: 'online', label: 'Online', cnt: counts.online },
                        { id: 'paused', label: 'Paused', cnt: counts.paused },
                      ] as const
                    ).map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setStatusFilter(f.id)}
                        className={`h-[34px] px-3.5 rounded-[9px] text-xs font-extrabold inline-flex items-center gap-1.5 transition-all cursor-pointer ${
                          statusFilter === f.id
                            ? 'bg-gradient-to-br from-[#ef4444] to-[#dc2626] text-[#080000] shadow-[0_6px_18px_rgba(239,68,68,0.35),inset_0_1px_0_rgba(255,255,255,0.3)]'
                            : 'text-[#a8a29e] hover:text-[#f7f5f0]'
                        }`}
                      >
                        <span>{f.label}</span>
                        <em className="not-italic font-mono-num text-[10.5px] px-[7px] py-[1px] rounded-[6px] bg-black/25">
                          {f.cnt}
                        </em>
                      </button>
                    ))}
                  </div>
                </div>

                {filteredAccounts.length === 0 ? (
                  <div className="rounded-2xl bg-[rgba(22,16,16,0.75)] border border-[rgba(239,68,68,0.14)] py-14 px-5 text-center text-[#a8a29e]">
                    <Bot size={36} className="mx-auto mb-3 text-[#ef4444] opacity-50" />
                    <p className="text-sm font-semibold mb-4">
                      {accounts.length === 0
                        ? 'No active bot accounts connected yet.'
                        : 'No matching accounts found.'}
                    </p>
                    <div className="flex justify-center gap-2.5">
                      <button
                        type="button"
                        onClick={() => setTeamOpen(true)}
                        className="h-10 px-4 rounded-xl bg-gradient-to-br from-[#10b981] to-[#34d399] text-[#080000] text-xs font-extrabold inline-flex items-center gap-2 cursor-pointer"
                      >
                        <Users size={14} />
                        Create Team
                      </button>
                      <button
                        type="button"
                        onClick={() => setAddOpen(true)}
                        className="h-10 px-4 rounded-xl bg-gradient-to-br from-[#ef4444] to-[#dc2626] text-[#080000] text-xs font-extrabold inline-flex items-center gap-2 cursor-pointer"
                      >
                        <Plus size={14} />
                        Add Account
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    className={`grid ${
                      compactMode
                        ? 'gap-2.5 grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))]'
                        : 'gap-4 grid-cols-[repeat(auto-fill,minmax(min(100%,350px),1fr))]'
                    }`}
                  >
                    {filteredAccounts.map((acc) => {
                      const cat = normalizeCategory(acc);
                      const prog = computeLevelProgress(acc.level, acc.current_exp || acc.exp || 0);
                      const squadMode = squads.find((sq) => sq.id === acc.squad_id)?.game_mode;
                      const statusLabel = formatStatusText(
                        acc.status || 'ONLINE',
                        normalizeGameMode(squadMode || 'BR_RANK'),
                      );
                      const matchesPlayed = Number(acc.matches_played ?? acc.matches ?? 0);
                      const matchMinutes = Math.max(0, Math.round((acc.uptime_seconds || 0) / 60));

                      return (
                        <div
                          key={acc.uid}
                          className={`group relative rounded-[16px] bg-gradient-to-br from-[rgba(22,16,16,0.78)] to-[rgba(30,21,21,0.6)] backdrop-blur-md border border-[rgba(239,68,68,0.16)] hover:border-[rgba(239,68,68,0.38)] hover:-translate-y-1 hover:shadow-[0_15px_50px_rgba(239,68,68,0.15)] transition-all overflow-hidden account-card ${
                            compactMode ? 'p-3.5' : 'p-5'
                          }`}
                        >
                          <span className="account-card-accent pointer-events-none absolute inset-x-5 top-0 h-px" />
                          {/* Tactical hover corner brackets */}
                          <span className="pointer-events-none absolute top-1.5 left-1.5 w-[14px] h-[14px] border-t-2 border-l-2 border-[#ef4444] rounded-tl-[4px] opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                          <span className="pointer-events-none absolute top-1.5 right-1.5 w-[14px] h-[14px] border-t-2 border-r-2 border-[#ef4444] rounded-tr-[4px] opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                          <span className="pointer-events-none absolute bottom-1.5 left-1.5 w-[14px] h-[14px] border-b-2 border-l-2 border-[#ef4444] rounded-bl-[4px] opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                          <span className="pointer-events-none absolute bottom-1.5 right-1.5 w-[14px] h-[14px] border-b-2 border-r-2 border-[#ef4444] rounded-br-[4px] opacity-0 group-hover:opacity-100 transition-opacity duration-300" />

                          <div className="flex items-center justify-between gap-2.5 mb-[18px]">
                            <div className="flex items-center gap-[13px] min-w-0">
                              <div
                                className={`relative shrink-0 grid place-items-center ${
                                  compactMode ? 'w-[52px] h-[52px]' : 'w-[62px] h-[62px]'
                                }`}
                              >
                                <div
                                  className="absolute inset-0 rounded-full"
                                  style={{
                                    background: `conic-gradient(from 0deg, #ef4444, #10b981, #14b8a6 ${prog.pct.toFixed(1)}%, rgba(255,255,255,0.06) 0)`,
                                    WebkitMaskImage:
                                      'radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 4px))',
                                    maskImage:
                                      'radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 4px))',
                                  }}
                                />
                                <span aria-hidden="true" className="account-avatar-orbit pointer-events-none absolute inset-[3px] rounded-full" />
                                <div
                                  className={`relative rounded-full bg-gradient-to-br from-[#1e1515] to-[#161010] border border-[rgba(239,68,68,0.35)] overflow-hidden grid place-items-center shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] ${
                                    compactMode ? 'w-10 h-10' : 'w-12 h-12'
                                  }`}
                                >
                                  <img
                                    src={acc.avatar || ffAvatar(acc.uid, acc.nickname)}
                                    alt={acc.nickname}
                                    className="w-full h-full object-cover rounded-full"
                                    onError={(e) => {
                                      e.currentTarget.style.display = 'none';
                                    }}
                                  />
                                  <User size={18} className="text-[#ef4444] absolute -z-10" />
                                </div>
                                <span className="absolute -right-2 -bottom-1 px-2 py-[2px] rounded-[7px] bg-gradient-to-br from-[#ef4444] to-[#dc2626] text-[10px] font-extrabold font-mono-num text-[#080000] border-2 border-[#080000] shadow-[0_4px_12px_rgba(239,68,68,0.4)]">
                                  L{prog.level}
                                </span>
                              </div>

                              <div className="min-w-0">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span
                                    className={`font-extrabold text-[#f7f5f0] truncate ${
                                      compactMode ? 'text-[13px]' : 'text-[14.5px]'
                                    }`}
                                  >
                                    {acc.nickname || 'Unknown'}
                                  </span>
                                  <span className="px-2 py-[2px] rounded-[6px] bg-[#14b8a6]/10 border border-[#14b8a6]/30 text-[#14b8a6] text-[9.5px] font-extrabold font-mono-num tracking-[0.5px] shrink-0">
                                    {acc.region || 'BD'}
                                  </span>
                                </div>
                                <div className="flex items-center gap-1.5 text-[11px] text-[#a8a29e] font-mono-num mt-[3px]">
                                  <span>UID {acc.uid}</span>
                                  <button
                                    type="button"
                                    onClick={() => handleCopyUid(acc.uid)}
                                    title="Copy UID"
                                    className="w-6 h-6 rounded-[7px] text-[#a8a29e] grid place-items-center hover:text-[#ef4444] hover:bg-red-500/10 transition-colors cursor-pointer"
                                  >
                                    <Copy size={11} />
                                  </button>
                                </div>
                                <div className="text-[11px] font-mono-num text-[#a8a29e] truncate mt-0.5">
                                  Guild:{' '}
                                  <span className={acc.guild_joined ? 'text-emerald-400 font-semibold' : 'text-[#f7f5f0]'}>
                                    {acc.clan_name || acc.clan_id || 'None'}
                                  </span>{' '}
                                  · Squad:{' '}
                                  <span className={acc.in_squad ? 'text-[#14b8a6] font-semibold' : 'text-[#f7f5f0]'}>
                                    {acc.squad_name || 'Unassigned'}
                                  </span>
                                </div>
                              </div>
                            </div>

                            <span
                              className={`shrink-0 inline-flex items-center gap-1.5 px-[11px] py-[7px] rounded-[10px] text-[10.5px] font-extrabold font-mono-num tracking-[0.3px] border backdrop-blur-sm ${
                                cat === 'match'
                                  ? 'bg-[#14b8a6]/12 border-[#14b8a6]/50 text-[#14b8a6] shadow-[0_0_20px_rgba(20,184,166,0.18)] account-status-live'
                                  : cat === 'online'
                                  ? 'bg-emerald-500/10 border-emerald-500/35 text-emerald-400 shadow-[0_0_20px_rgba(16,185,129,0.1)] account-status-live'
                                  : cat === 'search'
                                  ? 'bg-red-500/10 border-red-500/40 text-[#ef4444]'
                                  : cat === 'paused'
                                  ? 'bg-stone-400/10 border-stone-400/25 text-[#a8a29e]'
                                  : 'bg-amber-500/10 border-amber-500/35 text-amber-400'
                              }`}
                            >
                              <span aria-hidden="true" className="account-status-dot" />
                              {cat === 'match' ? (
                                <Crosshair size={11} />
                              ) : cat === 'online' ? (
                                <Globe size={11} />
                              ) : cat === 'paused' ? (
                                <Pause size={11} />
                              ) : cat === 'search' ? (
                                <Search size={11} />
                              ) : (
                                <TriangleAlert size={11} />
                              )}
                              <span className="text-right leading-tight">
                                <span className="block">{statusLabel}</span>
                              </span>
                            </span>
                          </div>

                          <div className={`grid grid-cols-3 ${compactMode ? 'gap-1.5 mb-3' : 'gap-2 mb-4'}`}>
                            <div
                              className={`rounded-[11px] bg-white/[0.02] border border-[rgba(239,68,68,0.16)] hover:bg-red-500/[0.06] hover:border-[rgba(239,68,68,0.35)] transition-all min-w-0 ${
                                compactMode ? 'p-2' : 'p-[11px]'
                              }`}
                            >
                              <span className="block text-[10.5px] font-bold text-[#a8a29e] mb-[3px]">
                                Matches
                              </span>
                              <strong className="block font-mono-num text-[12.5px] font-bold text-right truncate text-[#f7f5f0]">
                                {matchesPlayed.toLocaleString()}
                              </strong>
                            </div>
                            <div
                              className={`rounded-[11px] bg-white/[0.02] border border-[rgba(239,68,68,0.16)] hover:bg-red-500/[0.06] hover:border-[rgba(239,68,68,0.35)] transition-all min-w-0 ${
                                compactMode ? 'p-2' : 'p-[11px]'
                              }`}
                            >
                              <span className="block text-[10.5px] font-bold text-[#a8a29e] mb-[3px]">
                                Minutes
                              </span>
                              <strong className="block font-mono-num text-[12.5px] font-bold text-right truncate text-[#f7f5f0]">
                                {formatDuration(matchMinutes * 60)}
                              </strong>
                            </div>
                            <div
                              className={`rounded-[11px] bg-white/[0.02] border border-[rgba(239,68,68,0.16)] hover:bg-red-500/[0.06] hover:border-[rgba(239,68,68,0.35)] transition-all min-w-0 ${
                                compactMode ? 'p-2' : 'p-[11px]'
                              }`}
                            >
                              <span className="block text-[10.5px] font-bold text-[#a8a29e] mb-[3px]">
                                Group
                              </span>
                              <strong className={`block font-mono-num text-[11px] font-bold text-right truncate ${acc.in_squad ? 'text-emerald-400' : 'text-[#f7f5f0]'}`}>
                                {acc.in_squad ? 'In Group' : 'No Group'}
                              </strong>
                            </div>
                          </div>

                          <div>
                            <div className="flex justify-between gap-2 font-mono-num text-[11px] font-bold text-[#a8a29e]">
                              <span>Level {prog.level}</span>
                              <span>
                                {prog.isMax
                                  ? 'Max Level'
                                  : `${prog.remaining.toLocaleString()} EXP left`}
                              </span>
                              <span>Level {prog.nextLvl}</span>
                            </div>
                            <div className="h-2 mt-2 rounded-full bg-white/[0.04] border border-[rgba(239,68,68,0.16)] overflow-hidden">
                              <div
                                className="h-full rounded-full bg-gradient-to-r from-[#ef4444] via-[#10b981] to-[#14b8a6] transition-all duration-700"
                                style={{ width: `${prog.pct.toFixed(1)}%` }}
                              />
                            </div>
                            <div className="flex justify-between gap-2 font-mono-num text-[11px] font-bold text-[#a8a29e] mt-[7px]">
                              <span>
                                {prog.earned.toLocaleString()} / {prog.needed.toLocaleString()}
                              </span>
                              <span className="text-[#14b8a6] font-extrabold">{prog.pct.toFixed(1)}%</span>
                            </div>
                          </div>

                          <div
                            className={`flex items-center justify-between gap-2 border-t border-[rgba(239,68,68,0.16)] ${
                              compactMode ? 'mt-3 pt-2.5' : 'mt-4 pt-3.5'
                            }`}
                          >
                            <span className="inline-flex items-center gap-[7px] font-mono-num text-[11.5px] text-[#a8a29e]">
                              <Clock size={12} />
                              <b className="font-bold text-[#f7f5f0]">
                                {formatDuration(acc.uptime_seconds || 0)}
                              </b>
                            </span>
                            <div className="flex gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleTogglePause(acc.uid)}
                                title={cat === 'paused' ? 'Resume' : 'Pause'}
                                className="w-9 h-9 rounded-[10px] bg-white/[0.02] border border-[rgba(239,68,68,0.16)] grid place-items-center text-[#a8a29e] hover:text-[#f7f5f0] hover:border-[#ef4444] hover:bg-red-500/15 hover:-translate-y-0.5 hover:shadow-[0_6px_16px_rgba(239,68,68,0.2)] transition-all cursor-pointer"
                              >
                                {cat === 'paused' ? <Play size={13} /> : <Pause size={13} />}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRestartAccount(acc.uid)}
                                title="Restart"
                                className="w-9 h-9 rounded-[10px] bg-white/[0.02] border border-[rgba(239,68,68,0.16)] grid place-items-center text-[#a8a29e] hover:text-[#f7f5f0] hover:border-[#ef4444] hover:bg-red-500/15 hover:-translate-y-0.5 hover:shadow-[0_6px_16px_rgba(239,68,68,0.2)] transition-all cursor-pointer"
                              >
                                <RefreshCw size={13} />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRefreshAccount(acc.uid)}
                                title="Refresh EXP"
                                className="w-9 h-9 rounded-[10px] bg-white/[0.02] border border-[rgba(239,68,68,0.16)] grid place-items-center text-[#a8a29e] hover:text-[#f7f5f0] hover:border-[#ef4444] hover:bg-red-500/15 hover:-translate-y-0.5 hover:shadow-[0_6px_16px_rgba(239,68,68,0.2)] transition-all cursor-pointer"
                              >
                                <RefreshCw size={13} className="rotate-45" />
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setConfirmState({ open: true, uid: acc.uid, authUid: acc.auth_uid })
                                }
                                title="Delete"
                                className="w-9 h-9 rounded-[10px] bg-white/[0.02] border border-[rgba(239,68,68,0.16)] grid place-items-center text-[#a8a29e] hover:text-[#ef4444] hover:border-[#ef4444] hover:bg-red-500/12 hover:-translate-y-0.5 hover:shadow-[0_6px_16px_rgba(239,68,68,0.25)] transition-all cursor-pointer"
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            )}

            {/* MY SQUAD PAGE */}
            {page === 'squad' && (
              <MySquadView
                guilds={guilds}
                squads={squads}
                accounts={accounts}
                creating={creatingBots}
                onLookupClan={handleLookupClan}
                onCreateGuild={handleCreateGuild}
                onUpdateGuild={handleUpdateGuild}
                onDeleteGuild={handleDeleteGuild}
                onCreateSquad={handleCreateSquad}
                onUpdateSquad={handleUpdateSquad}
                onRestartSquad={handleRestartSquad}
                onDeleteSquad={handleDeleteSquad}
                onTogglePauseBot={handleTogglePause}
                onRestartBot={handleRestartAccount}
                onDeleteBot={(uid, authUid) => setConfirmState({ open: true, uid, authUid })}
                onCopyText={handleCopyUid}
              />
            )}

            {/* LIVE CONSOLE */}
            {page === 'terminal' && (
              <section>
                <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
                  <div>
                    <h1 className="font-display text-2xl sm:text-[28px] font-extrabold tracking-tight bg-gradient-to-br from-[#ef4444] via-[#f7f5f0] to-emerald-400 bg-clip-text text-transparent">
                      Live Console
                    </h1>
                    <p className="text-[#a8a29e] text-[13.5px] font-medium mt-0.5">
                      Real-time server execution logs
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setAutoScroll((v) => !v)}
                      className={`h-10 px-4 rounded-xl border text-[13px] font-bold inline-flex items-center gap-2 cursor-pointer ${
                        autoScroll
                          ? 'bg-red-500/15 border-[#ef4444] text-[#ef4444]'
                          : 'bg-[#161010] border-[rgba(239,68,68,0.18)] text-[#a8a29e]'
                      }`}
                    >
                      <ArrowDown size={14} />
                      Auto-scroll
                    </button>
                    <button
                      type="button"
                      onClick={handleClearLogs}
                      className="h-10 px-4 rounded-xl bg-[#161010] border border-[rgba(239,68,68,0.18)] text-[13px] font-bold inline-flex items-center gap-2 hover:border-[#ef4444] cursor-pointer"
                    >
                      <Trash2 size={14} />
                      Clear Logs
                    </button>
                  </div>
                </div>

                <div className="mb-4">
                  <div className="inline-flex gap-1 p-1 rounded-xl bg-[#161010] border border-[rgba(239,68,68,0.16)]">
                    {(
                      [
                        { id: 'all', label: 'All' },
                        { id: 'match', label: 'Matches' },
                        { id: 'success', label: 'EXP' },
                        { id: 'error', label: 'Errors' },
                      ] as const
                    ).map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setLogFilter(f.id)}
                        className={`h-8 px-3 rounded-lg text-xs font-bold cursor-pointer ${
                          logFilter === f.id
                            ? 'bg-gradient-to-br from-[#ef4444] to-[#dc2626] text-[#f7f5f0]'
                            : 'text-[#a8a29e] hover:text-[#f7f5f0]'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="rounded-2xl bg-[#0f0000] border border-[rgba(239,68,68,0.18)] overflow-hidden shadow-2xl">
                  <div className="flex items-center justify-between px-4 py-3 bg-[#161010] border-b border-[rgba(239,68,68,0.14)] font-mono-num text-xs text-[#a8a29e]">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-[#ef4444]" />
                      <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
                      <span className="ml-2">RDX_TEM@backend:~#</span>
                    </div>
                    <span className="px-2 py-0.5 rounded bg-[#1e1515] border border-[rgba(239,68,68,0.18)] text-[11px]">
                      {filteredLogs.length}
                    </span>
                  </div>
                  <div
                    ref={consoleRef}
                    className="h-[min(62vh,520px)] overflow-y-auto p-4 font-mono-num text-xs leading-7"
                  >
                    {filteredLogs.length === 0 ? (
                      <div className="py-16 text-center text-[#a8a29e]">No logs yet.</div>
                    ) : (
                      filteredLogs.slice(-300).map((log, i) => (
                        <div key={`${log.time}_${i}`} className="flex gap-2.5 py-0.5">
                          <span className="text-[#a8a29e]/70 shrink-0">[{log.time}]</span>
                          <span
                            className={`break-words ${
                              log.level === 'success'
                                ? 'text-emerald-400'
                                : log.level === 'error'
                                ? 'text-[#ef4444]'
                                : log.level === 'warning'
                                ? 'text-amber-400'
                                : 'text-[#f7f5f0]'
                            }`}
                          >
                            {log.message}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </section>
            )}
          </div>
        </main>
      </div>

      {/* MOBILE TABBAR */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 h-[66px] z-30 flex bg-[rgba(15,0,0,0.95)] backdrop-blur-xl border-t border-[rgba(239,68,68,0.18)]">
        {(
          [
            { id: 'core', label: 'Home', icon: Gauge },
            { id: 'targets', label: 'Accounts', icon: Network },
            { id: 'squad', label: 'Squad', icon: Shield },
            { id: 'terminal', label: 'Console', icon: Terminal },
          ] as const
        ).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setPage(id)}
            className={`flex-1 flex flex-col items-center justify-center gap-1 text-[10.5px] font-bold cursor-pointer ${
              page === id ? 'text-[#ef4444]' : 'text-[#a8a29e]'
            }`}
          >
            <Icon size={16} />
            <span>{label}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => setTeamOpen(true)}
          className="flex-1 flex flex-col items-center justify-center gap-1 text-[10.5px] font-bold text-emerald-400 cursor-pointer"
        >
          <Users size={16} />
          <span>Team</span>
        </button>
      </nav>

      {/* NOTIFICATIONS DRAWER */}
      {notifOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-xs"
          onClick={() => setNotifOpen(false)}
        />
      )}
      <aside
        className={`fixed top-0 right-0 bottom-0 w-full max-w-[380px] z-50 bg-[rgba(22,16,16,0.98)] border-l border-[rgba(239,68,68,0.3)] backdrop-blur-xl flex flex-col transition-transform duration-300 ${
          notifOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex items-center gap-2.5 p-5 border-b border-[rgba(239,68,68,0.16)]">
          <Bell size={16} className="text-[#ef4444]" />
          <h3 className="font-display font-extrabold text-[15px] flex-1">Notifications</h3>
          <span className="px-2.5 py-0.5 rounded-full bg-red-500/15 text-[#ef4444] text-[11px] font-bold font-mono-num">
            {unreadCount} New
          </span>
          <button
            type="button"
            onClick={() => setNotifOpen(false)}
            className="w-8 h-8 rounded-lg bg-[#1e1515] border border-[rgba(239,68,68,0.16)] grid place-items-center text-[#a8a29e] hover:text-[#ef4444] cursor-pointer"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
          {notifications.length === 0 ? (
            <div className="py-16 text-center text-[#a8a29e] text-xs font-semibold">
              No notifications yet
            </div>
          ) : (
            notifications.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => {
                  setNotifications((prev) =>
                    prev.map((x) => (x.id === n.id ? { ...x, read: true } : x))
                  );
                }}
                className={`w-full text-left p-3.5 rounded-xl border flex gap-3 items-start cursor-pointer ${
                  n.read
                    ? 'bg-white/[0.02] border-[rgba(239,68,68,0.12)]'
                    : 'bg-red-500/5 border-[rgba(239,68,68,0.3)]'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-xs mb-0.5">{n.title}</div>
                  <div className="text-[11.5px] text-[#a8a29e] break-words">{n.message}</div>
                  <div className="text-[10px] font-mono-num text-[#a8a29e]/70 mt-1">{n.time}</div>
                </div>
              </button>
            ))
          )}
        </div>

        <div className="p-3 border-t border-[rgba(239,68,68,0.16)] flex gap-2">
          <button
            type="button"
            onClick={() => {
              const next = notifications.map((n) => ({ ...n, read: true }));
              setNotifications(next);
              sessionStorage.setItem(NOTIF_KEY, JSON.stringify(next));
              addToast('All marked as read', 'success');
            }}
            className="flex-1 h-9 rounded-xl bg-[#1e1515] border border-[rgba(239,68,68,0.16)] text-xs font-bold inline-flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <CheckCheck size={14} />
            Mark All Read
          </button>
          <button
            type="button"
            onClick={() => {
              setNotifications([]);
              sessionStorage.removeItem(NOTIF_KEY);
              addToast('Notifications cleared', 'info');
            }}
            className="flex-1 h-9 rounded-xl bg-red-500/10 border border-red-500/35 text-[#ef4444] text-xs font-bold inline-flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Trash2 size={14} />
            Clear All
          </button>
        </div>
      </aside>

      {/* TOASTS */}
      <div className="fixed bottom-20 lg:bottom-5 right-5 z-50 flex flex-col gap-2 max-w-[340px] pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-[#161010] border border-[rgba(239,68,68,0.35)] shadow-2xl text-xs font-semibold pointer-events-auto"
          >
            {t.type === 'success' ? (
              <Check size={14} className="text-emerald-400 shrink-0" />
            ) : t.type === 'error' ? (
              <TriangleAlert size={14} className="text-[#ef4444] shrink-0" />
            ) : (
              <Bell size={14} className="text-amber-400 shrink-0" />
            )}
            <span>{t.message}</span>
          </div>
        ))}
      </div>

      {/* MODALS */}
      <AddAccountModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        guilds={guilds}
        squads={squads}
        onLookupClan={handleLookupClan}
        onSubmit={handleAddAccount}
      />
      <CreateTeamModal
        open={teamOpen}
        onClose={() => setTeamOpen(false)}
        guilds={guilds}
        squads={squads}
        onLookupClan={handleLookupClan}
        onSubmit={handleCreateTeam}
      />
      <ConfirmModal
        open={confirmState.open}
        title="Remove Account"
        message={`Remove account ${confirmState.uid}? This cannot be undone.`}
        onCancel={() => setConfirmState({ open: false, uid: '' })}
        onConfirm={handleConfirmDelete}
      />
      <ConfirmModal
        open={clearAllOpen}
        title="Clear All Bots"
        message={`Delete all ${accounts.length} bot account(s) from the engine and Cloud Backup? Guilds and Squad configurations will be kept.`}
        onCancel={() => setClearAllOpen(false)}
        onConfirm={handleConfirmClearAll}
      />
      <EngineModal
        open={engineOpen}
        onClose={() => setEngineOpen(false)}
        apiBase={apiBase}
        onSaveApiBase={(next) => {
          setApiBase(next);
          if (next) localStorage.setItem(API_BASE_KEY, next);
          else localStorage.removeItem(API_BASE_KEY);
          fetchStats(true);
        }}
      />
    </div>
  );
}
