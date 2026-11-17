import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Activity,
  BadgeCheck,
  Bot,
  Check,
  Clock,
  Copy,
  Crown,
  Edit3,
  Globe2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Shield,
  Trash2,
  UserMinus,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import {
  GAME_MODE_LABELS,
  type BotAccount,
  type GameModeId,
  type GuildInfo,
  type SquadInfo,
  formatDuration,
  formatStatusText,
  normalizeCategory,
  normalizeGameMode,
} from '../types';

interface MySquadViewProps {
  guilds: GuildInfo[];
  squads: SquadInfo[];
  accounts: BotAccount[];
  creating: boolean;
  onLookupClan: (clanId: string) => Promise<{ found: boolean; name?: string; region?: string }>;
  onCreateGuild: (payload: {
    clan_id: string;
    name?: string;
    days: number;
    hours: number;
    minutes: number;
  }) => Promise<boolean>;
  onUpdateGuild: (payload: {
    clan_id: string;
    name?: string;
    days?: number;
    hours?: number;
    minutes?: number;
    is_paused?: boolean;
  }) => Promise<boolean>;
  onDeleteGuild: (clanId: string, deleteAccounts: boolean) => Promise<void>;
  onCreateSquad: (payload: {
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
  }) => Promise<boolean>;
  onUpdateSquad: (payload: {
    squad_id: string;
    name?: string;
    target_size?: number;
    game_mode?: GameModeId;
    lobby_delay_sec?: number;
    bot_prefix?: string;
    is_paused?: boolean;
    add_uids?: string[];
    remove_uids?: string[];
  }) => Promise<boolean>;
  onRestartSquad: (squadId: string) => Promise<void>;
  onDeleteSquad: (squadId: string, deleteAccounts: boolean) => Promise<void>;
  onTogglePauseBot: (uid: string) => Promise<void>;
  onRestartBot: (uid: string) => Promise<void>;
  onDeleteBot: (uid: string, authUid?: string) => void;
  onCopyText: (val: string, label?: string) => void;
}

function getOrderedSquadPlayers(accounts: BotAccount[], squad: SquadInfo): BotAccount[] {
  const memberOrder = new Map(squad.member_uids.map((uid, index) => [uid, index]));
  return accounts
    .filter((account) => account.squad_id === squad.id || memberOrder.has(account.uid))
    .sort((a, b) => {
      const aOrder = memberOrder.get(a.uid) ?? Number.MAX_SAFE_INTEGER;
      const bOrder = memberOrder.get(b.uid) ?? Number.MAX_SAFE_INTEGER;
      return aOrder - bOrder || a.uid.localeCompare(b.uid);
    });
}

function getSquadFlowSteps(squad: SquadInfo, players: BotAccount[]) {
  const expectedPlayers = Math.max(2, Math.min(4, squad.target_size || players.length));
  const guildReady = squad.guild_joined_count >= expectedPlayers;
  const groupReady = Boolean(
    squad.team_code &&
      squad.group_id &&
      squad.in_squad_count >= expectedPlayers,
  );
  const statuses = players.map((player) => String(player.status || '').toUpperCase());
  const searching = statuses.some((status) =>
    ['START_MATCH', 'SEARCHING'].includes(status),
  );
  const matchmaking = statuses.includes('MATCHING');
  const retryPending = statuses.includes('MATCH_CANCELLED') || squad.status === 'MATCH RETRY';
  const requestPending = searching || matchmaking || squad.status === 'SEARCHING';
  const joiningGame = statuses.includes('MATCH_RESUMING') || (squad.match_recovering_count || 0) > 0;
  const inGame = squad.in_match_count > 0 || statuses.includes('IN_MATCH');
  const matchFound = joiningGame || inGame;
  const cycleMatches = squad.completed_matches_in_cycle || 0;
  const cycleComplete =
    cycleMatches > 0 && !searching && !matchmaking && !retryPending && !matchFound;
  const modeName = GAME_MODE_LABELS[normalizeGameMode(squad.game_mode)];
  const leaderName =
    players.find((player) => player.uid === squad.leader_uid)?.nickname || 'Team leader';
  const searchConfirmed = matchFound || cycleComplete;
  const searchRequested = searching || matchmaking || retryPending;
  const searchStartedAt = Math.max(0, Number(squad.matchmaking_started_at) || 0);
  const matchStartedAt = Math.max(0, Number(squad.match_started_at) || 0);
  const now = Date.now();
  const queueElapsed = searchStartedAt > 0 ? Math.floor(Math.max(0, now - searchStartedAt) / 1000) : 0;
  const matchElapsed = matchStartedAt > 0 ? Math.floor(Math.max(0, now - matchStartedAt) / 1000) : 0;

  return [
    {
      title: 'Guild Join',
      detail: `${squad.guild_joined_count}/${expectedPlayers} players joined`,
      state: guildReady ? 'done' : 'active',
      timer: null,
    },
    {
      title: 'Create & Join Squad',
      detail: groupReady
        ? `Leader squad ready · Code ${squad.team_code}`
        : `${squad.in_squad_count}/${expectedPlayers} server-confirmed`,
      state: groupReady ? 'done' : guildReady ? 'active' : 'pending',
      timer: null,
    },
    {
      title: 'Ranked Search',
      detail: cycleComplete
        ? `${modeName} selected by ${leaderName} · match complete`
        : retryPending
          ? `${modeName} selected by ${leaderName} · server rejected, retry pending`
        : requestPending
          ? `${modeName} selected by ${leaderName} · request sent, awaiting game confirmation`
          : matchFound
            ? `${modeName} selected by ${leaderName} · match confirmed`
            : `${modeName} selected by ${leaderName}`,
      state: searchConfirmed
        ? 'done'
        : retryPending
          ? 'failed'
          : searchRequested
            ? 'active'
            : groupReady
              ? 'active'
              : 'pending',
      timer: null,
    },
    {
      title: 'Match Start',
      detail: matchFound
        ? `${leaderName} started ${modeName} · server confirmed`
          : retryPending
            ? 'Match request cancelled or rejected · retry pending'
            : requestPending
              ? `${modeName} start request sent · waiting for server confirmation`
          : cycleComplete
            ? `Match complete · ${cycleMatches}/${squad.match_reset_threshold}`
            : groupReady
              ? `Waiting for ${leaderName} to start ${modeName}`
              : 'Waiting for the full squad',
      state: matchFound
        ? 'done'
        : retryPending
          ? 'failed'
          : requestPending
            ? 'active'
          : cycleComplete
            ? 'done'
            : 'pending',
      timer:
        requestPending && searchStartedAt > 0
          ? { label: 'Request elapsed', value: formatDuration(queueElapsed) }
          : null,
    },
    {
      title: 'In Game',
      detail: inGame
        ? 'Match is live'
        : joiningGame
          ? 'Joining the game'
          : cycleComplete
            ? `Match complete · ${cycleMatches}/${squad.match_reset_threshold}`
            : 'Waiting for match start',
      state: inGame ? 'live' : joiningGame ? 'active' : cycleComplete ? 'done' : 'pending',
      timer:
        inGame && matchStartedAt > 0
          ? { label: 'Match time', value: formatDuration(matchElapsed) }
          : null,
    },
  ] as const;
}

export function MySquadView({
  guilds,
  squads,
  accounts,
  creating,
  onLookupClan,
  onCreateGuild,
  onUpdateGuild,
  onDeleteGuild,
  onCreateSquad,
  onUpdateSquad,
  onRestartSquad,
  onDeleteSquad,
  onTogglePauseBot,
  onRestartBot,
  onDeleteBot,
  onCopyText,
}: MySquadViewProps) {
  const [selectedClanId, setSelectedClanId] = useState<string | null>(null);
  const [selectedSquadId, setSelectedSquadId] = useState<string | null>(null);

  // Guild Create / Edit Modal
  const [guildModal, setGuildModal] = useState<{ open: boolean; editing: GuildInfo | null }>({
    open: false,
    editing: null,
  });
  const [gUid, setGUid] = useState('');
  const [gName, setGName] = useState('');
  const [gDays, setGDays] = useState(0);
  const [gHours, setGHours] = useState(12);
  const [gMinutes, setGMinutes] = useState(0);
  const [lookupState, setLookupState] = useState<'idle' | 'loading' | 'verified' | 'manual'>('idle');
  const [gSaving, setGSaving] = useState(false);

  // Squad Create Modal
  const [squadModalOpen, setSquadModalOpen] = useState(false);
  const [sqName, setSqName] = useState('');
  const [sqMode, setSqMode] = useState<'create_bots' | 'assign_existing'>('create_bots');
  const [sqGameMode, setSqGameMode] = useState<GameModeId>('BR_RANK');
  const [sqBotPrefix, setSqBotPrefix] = useState('RDX');
  const [sqCount, setSqCount] = useState(4);
  const [sqPassword, setSqPassword] = useState('RDX771');
  const [sqSelectedUids, setSqSelectedUids] = useState<string[]>([]);
  const [sqSaving, setSqSaving] = useState(false);

  // Squad Edit Modal
  const [editSquad, setEditSquad] = useState<SquadInfo | null>(null);
  const [editSqName, setEditSqName] = useState('');
  const [editSqSize, setEditSqSize] = useState(4);
  const [editSqGameMode, setEditSqGameMode] = useState<GameModeId>('BR_RANK');
  const [editSqBotPrefix, setEditSqBotPrefix] = useState('RDX');
  const [addPlayerUid, setAddPlayerUid] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  // Add / Replace Bot in Existing Squad Modal
  const [addBotModal, setAddBotModal] = useState<SquadInfo | null>(null);
  const [addBotCount, setAddBotCount] = useState(1);
  const [addBotPass, setAddBotPass] = useState('RDX771');
  const [addBotPrefix, setAddBotPrefix] = useState('RDX');
  const [addBotSaving, setAddBotSaving] = useState(false);

  // Confirm delete dialog
  const [confirmDelete, setConfirmDelete] = useState<
    | { type: 'guild'; guild: GuildInfo }
    | { type: 'squad'; squad: SquadInfo }
    | null
  >(null);

  // Live countdown tick for guild remaining_seconds
  const [tickOffset, setTickOffset] = useState(0);
  useEffect(() => {
    setTickOffset(0);
    const id = setInterval(() => setTickOffset((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [guilds]);

  // Keep selected pointers valid if deleted
  useEffect(() => {
    if (selectedClanId && !guilds.some((g) => g.clan_id === selectedClanId)) {
      setSelectedClanId(null);
      setSelectedSquadId(null);
    }
  }, [guilds, selectedClanId]);

  useEffect(() => {
    if (selectedSquadId && !squads.some((s) => s.id === selectedSquadId)) {
      setSelectedSquadId(null);
    }
  }, [squads, selectedSquadId]);

  const activeGuild = useMemo(
    () => (selectedClanId ? guilds.find((g) => g.clan_id === selectedClanId) || null : null),
    [guilds, selectedClanId],
  );

  const guildSquads = useMemo(
    () => (activeGuild ? squads.filter((s) => s.clan_id === activeGuild.clan_id) : []),
    [squads, activeGuild],
  );

  const activeSquad = useMemo(
    () => (selectedSquadId ? squads.find((s) => s.id === selectedSquadId) || null : null),
    [squads, selectedSquadId],
  );

  const squadPlayers = useMemo(() => {
    if (!activeSquad) return [];
    return getOrderedSquadPlayers(accounts, activeSquad);
  }, [accounts, activeSquad]);

  const unassignedOrMovableAccounts = useMemo(() => {
    if (!editSquad) return accounts;
    return accounts.filter((a) => a.squad_id !== editSquad.id);
  }, [accounts, editSquad]);

  const openCreateGuild = () => {
    setGuildModal({ open: true, editing: null });
    setGUid('');
    setGName('');
    setGDays(0);
    setGHours(12);
    setGMinutes(0);
    setLookupState('idle');
  };

  const openEditGuild = (g: GuildInfo) => {
    setGuildModal({ open: true, editing: g });
    setGUid(g.clan_id);
    setGName(g.name);
    setGDays(g.duration_days || 0);
    setGHours(g.duration_hours || 0);
    setGMinutes(g.duration_minutes || 0);
    setLookupState(g.verified ? 'verified' : 'manual');
  };

  const handleLookupClan = async (uidVal: string) => {
    const clean = uidVal.trim();
    if (!/^\d{5,}$/.test(clean)) return;
    setLookupState('loading');
    const res = await onLookupClan(clean);
    if (res.found && res.name) {
      setGName(res.name);
      setLookupState('verified');
    } else {
      setLookupState('manual');
    }
  };

  const handleGuildSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanUid = gUid.trim();
    if (!/^\d+$/.test(cleanUid)) return;
    setGSaving(true);
    try {
      const ok = guildModal.editing
        ? await onUpdateGuild({
            clan_id: cleanUid,
            name: gName.trim() || undefined,
            days: gDays,
            hours: gHours,
            minutes: gMinutes,
          })
        : await onCreateGuild({
            clan_id: cleanUid,
            name: gName.trim() || undefined,
            days: gDays,
            hours: gHours,
            minutes: gMinutes,
          });
      if (ok) {
        setGuildModal({ open: false, editing: null });
      }
    } finally {
      setGSaving(false);
    }
  };

  const openCreateSquadModal = () => {
    if (!activeGuild) return;
    setSqName(`Squad ${guildSquads.length + 1}`);
    setSqMode('create_bots');
    setSqGameMode('BR_RANK');
    setSqBotPrefix('RDX');
    setSqCount(4);
    setSqPassword('RDX771');
    setSqSelectedUids([]);
    setSquadModalOpen(true);
  };

  const cleanPrefix = (raw: string) => (raw || 'RDX').replace(/[^\w-]/g, '').slice(0, 6) || 'RDX';

  const handleCreateSquadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeGuild) return;
    setSqSaving(true);
    try {
      const ok = await onCreateSquad({
        clan_id: activeGuild.clan_id,
        name: sqName.trim() || undefined,
        target_size: sqMode === 'create_bots' ? Math.min(4, Math.max(2, sqCount)) : Math.min(4, Math.max(2, sqSelectedUids.length)),
        game_mode: sqGameMode,
        lobby_delay_sec: 0,
        bot_prefix: cleanPrefix(sqBotPrefix),
        mode: sqMode,
        count: sqMode === 'create_bots' ? sqCount : undefined,
        password: sqMode === 'create_bots' ? sqPassword.trim() || 'RDX771' : undefined,
        account_uids: sqMode === 'assign_existing' ? sqSelectedUids : undefined,
      });
      if (ok) setSquadModalOpen(false);
    } finally {
      setSqSaving(false);
    }
  };

  const openEditSquadModal = (sq: SquadInfo) => {
    setEditSquad(sq);
    setEditSqName(sq.name);
    setEditSqSize(sq.target_size || 4);
    setEditSqGameMode(normalizeGameMode(sq.game_mode));
    setEditSqBotPrefix(sq.bot_prefix || 'RDX');
    setAddPlayerUid('');
  };

  const handleEditSquadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editSquad) return;
    setEditSaving(true);
    try {
      const ok = await onUpdateSquad({
        squad_id: editSquad.id,
        name: editSqName.trim() || editSquad.name,
        target_size: editSqSize,
        game_mode: editSqGameMode,
        lobby_delay_sec: 0,
        bot_prefix: cleanPrefix(editSqBotPrefix),
        add_uids: addPlayerUid ? [addPlayerUid] : undefined,
      });
      if (ok) setEditSquad(null);
    } finally {
      setEditSaving(false);
    }
  };

  const openAddBotToSquadModal = (sq: SquadInfo, currentCount: number) => {
    const missing = Math.max(1, (sq.target_size || 4) - currentCount);
    setAddBotModal(sq);
    setAddBotCount(Math.min(4, missing));
    setAddBotPass('RDX771');
    setAddBotPrefix(sq.bot_prefix || 'RDX');
  };

  const handleAddBotToSquadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addBotModal) return;
    setAddBotSaving(true);
    try {
      const ok = await onCreateSquad({
        clan_id: addBotModal.clan_id,
        target_squad_id: addBotModal.id,
        bot_prefix: cleanPrefix(addBotPrefix),
        mode: 'create_bots',
        count: Math.max(1, Math.min(4, addBotCount)),
        password: addBotPass.trim() || 'RDX771',
      });
      if (ok) setAddBotModal(null);
    } finally {
      setAddBotSaving(false);
    }
  };

  return (
    <section>
      {/* HEADER BAR */}
      <div className="relative isolate overflow-hidden rounded-[22px] border border-[rgba(239,68,68,0.18)] bg-gradient-to-br from-[#191313] via-[#141010] to-[#0d1110] p-5 sm:p-6 mb-5 shadow-[0_18px_50px_rgba(0,0,0,0.22)]">
        <div aria-hidden="true" className="pointer-events-none absolute -right-20 -top-32 h-64 w-64 rounded-full bg-[#14b8a6]/[0.07] blur-3xl" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-28 -left-16 h-52 w-52 rounded-full bg-[#ef4444]/[0.06] blur-3xl" />
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-[#14b8a6]/70 to-transparent" />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="mt-1 grid h-11 w-11 shrink-0 place-items-center rounded-[14px] border border-[#ef4444]/20 bg-[#ef4444]/[0.08] text-[#ff8585] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
              <Shield size={20} />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-[#a8a29e] mb-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedClanId(null);
                    setSelectedSquadId(null);
                  }}
                  className={`transition-colors cursor-pointer ${
                    !activeGuild ? 'text-[#ff8585]' : 'hover:text-[#f7f5f0]'
                  }`}
                >
                  My Squad Guilds
                </button>
                {activeGuild && (
                  <>
                    <span aria-hidden="true" className="text-white/20">/</span>
                    <button
                      type="button"
                      onClick={() => setSelectedSquadId(null)}
                      className={`transition-colors cursor-pointer ${
                        !activeSquad ? 'text-[#ff8585]' : 'hover:text-[#f7f5f0]'
                      }`}
                    >
                      {activeGuild.name} ({activeGuild.clan_id})
                    </button>
                  </>
                )}
                {activeSquad && (
                  <>
                    <span aria-hidden="true" className="text-white/20">/</span>
                    <span className="text-[#f7f5f0]">{activeSquad.name}</span>
                  </>
                )}
              </div>

              <h1 className="font-display text-[26px] sm:text-[30px] font-extrabold tracking-tight text-[#f7f5f0]">
                {activeSquad
                  ? activeSquad.name
                  : activeGuild
                  ? activeGuild.name
                  : 'My Squad'}
              </h1>
              <p className="text-[#a8a29e] text-[12.5px] sm:text-[13px] font-medium mt-1">
                {activeSquad
                  ? `Guild: ${activeSquad.clan_name} (${activeSquad.clan_id}) · ${squadPlayers.length} / ${activeSquad.target_size} Players`
                  : activeGuild
                  ? `Guild UID ${activeGuild.clan_id} · ${guildSquads.length} Squads · Isolated per-squad team grouping`
                  : `${guilds.length} Guild(s) · ${squads.length} Squad(s) · ${accounts.length} Player(s)`}
              </p>
            </div>
          </div>

          <div className="relative flex flex-wrap items-center gap-2.5">
          {(activeGuild || activeSquad) && (
            <button
              type="button"
              onClick={() => {
                if (activeSquad) setSelectedSquadId(null);
                else setSelectedClanId(null);
              }}
              className="h-10 px-4 rounded-xl bg-[#161010] border border-[rgba(239,68,68,0.22)] text-[13px] font-bold inline-flex items-center gap-2 hover:border-[#ef4444] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <ArrowLeft size={14} />
              Back
            </button>
          )}

          {!activeGuild && (
            <button
              type="button"
              onClick={openCreateGuild}
              className="h-10 px-4 rounded-xl bg-gradient-to-br from-[#ef4444] to-[#dc2626] text-[#f7f5f0] text-[13px] font-bold inline-flex items-center gap-2 shadow-[0_6px_20px_rgba(239,68,68,0.28)] whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus size={15} />
              Create Guild
            </button>
          )}

          {activeGuild && !activeSquad && (
            <>
              <button
                type="button"
                onClick={() => openEditGuild(activeGuild)}
                className="h-10 px-4 rounded-xl bg-[#161010] border border-[rgba(239,68,68,0.22)] text-[13px] font-bold inline-flex items-center gap-2 hover:border-[#ef4444] whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Clock size={14} className="text-[#ef4444]" />
                Edit Timer
              </button>
              <button
                type="button"
                onClick={openCreateSquadModal}
                className="h-10 px-4 rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-400 text-[#080000] text-[13px] font-bold inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Users size={14} />
                Create Squad
              </button>
            </>
          )}

          {activeSquad && (
            <>
              {squadPlayers.length < 4 && (
                <button
                  type="button"
                  onClick={() => openAddBotToSquadModal(activeSquad, squadPlayers.length)}
                  className="h-10 px-4 rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-400 text-[#080000] text-[13px] font-bold inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Plus size={14} />
                  Add / Replace Bot
                </button>
              )}
              <button
                type="button"
                onClick={() => openEditSquadModal(activeSquad)}
                className="h-10 px-4 rounded-xl bg-[#161010] border border-[rgba(239,68,68,0.22)] text-[13px] font-bold inline-flex items-center gap-2 hover:border-[#ef4444] whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Edit3 size={14} />
                Edit Squad
              </button>
              <button
                type="button"
                onClick={() => void onRestartSquad(activeSquad.id)}
                className="h-10 px-4 rounded-xl bg-gradient-to-br from-[#ef4444] to-[#dc2626] text-[#f7f5f0] text-[13px] font-bold inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <RefreshCw size={14} />
                Restart &amp; Group
              </button>
            </>
          )}
          </div>
        </div>
      </div>

      {/* LEVEL 1: GUILD CARDS */}
      {!activeGuild && (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
            {[
              {
                label: 'Guilds',
                value: guilds.length,
                detail: 'Guild workspaces',
                icon: Shield,
                tone: 'text-[#ff8585] border-[#ef4444]/15 bg-[#ef4444]/[0.06]',
              },
              {
                label: 'Squads',
                value: squads.length,
                detail: 'Isolated teams',
                icon: Users,
                tone: 'text-[#5eead4] border-[#14b8a6]/15 bg-[#14b8a6]/[0.06]',
              },
              {
                label: 'Players',
                value: accounts.length,
                detail: 'Connected accounts',
                icon: Bot,
                tone: 'text-emerald-300 border-emerald-400/15 bg-emerald-400/[0.06]',
              },
              {
                label: 'In Match',
                value: squads.filter((squad) => squad.in_match_count > 0).length,
                detail: 'Live match sessions',
                icon: Activity,
                tone: 'text-amber-300 border-amber-400/15 bg-amber-400/[0.06]',
              },
            ].map((stat) => (
              <div
                key={stat.label}
                className="flex min-w-0 items-center gap-3 rounded-[16px] border border-white/[0.07] bg-gradient-to-br from-[#171313] to-[#100d0d] p-3.5 shadow-[0_10px_28px_rgba(0,0,0,0.12)]"
              >
                <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl border ${stat.tone}`}>
                  <stat.icon size={16} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <strong className="font-mono-num text-[20px] leading-none text-[#f7f5f0]">
                      {stat.value}
                    </strong>
                    <span className="truncate text-[10px] font-bold uppercase tracking-[0.7px] text-[#a8a29e]">
                      {stat.label}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-[10px] text-[#a8a29e]/75">{stat.detail}</p>
                </div>
              </div>
            ))}
          </div>

          {guilds.length === 0 ? (
            <div className="rounded-2xl bg-[#161010] border border-[rgba(239,68,68,0.16)] py-14 px-6 text-center">
              <Shield size={36} className="mx-auto mb-3 text-[#ef4444] opacity-60" />
              <p className="text-sm font-semibold text-[#f7f5f0] mb-1.5">No Guilds Created Yet</p>
              <p className="text-xs text-[#a8a29e] mb-5 max-w-md mx-auto">
                Create 1 to 4+ Guilds with their Guild UID and active duration timer, then create isolated Squads of 2–4 players inside each Guild.
              </p>
              <button
                type="button"
                onClick={openCreateGuild}
                className="h-10 px-5 rounded-xl bg-gradient-to-br from-[#ef4444] to-[#dc2626] text-[#f7f5f0] text-xs font-extrabold inline-flex items-center gap-2 cursor-pointer"
              >
                <Plus size={14} />
                Create First Guild
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] gap-4">
              {guilds.map((g) => {
                const rem =
                  g.remaining_seconds === null
                    ? null
                    : Math.max(0, g.remaining_seconds - tickOffset);
                const isExpired = g.expires_at !== null && rem === 0;
                const statusText = g.is_paused
                  ? 'PAUSED'
                  : isExpired
                  ? 'EXPIRED'
                  : 'ACTIVE';
                const totalDuration =
                  Math.max(0, Number(g.duration_days) || 0) * 86400 +
                  Math.max(0, Number(g.duration_hours) || 0) * 3600 +
                  Math.max(0, Number(g.duration_minutes) || 0) * 60;
                const timePct =
                  rem === null
                    ? 100
                    : totalDuration > 0
                    ? Math.max(0, Math.min(100, (rem / totalDuration) * 100))
                    : 0;
                const statusTone =
                  statusText === 'ACTIVE'
                    ? 'text-emerald-300 border-emerald-400/25 bg-emerald-400/[0.08]'
                    : statusText === 'PAUSED'
                    ? 'text-amber-300 border-amber-400/25 bg-amber-400/[0.08]'
                    : 'text-red-300 border-red-400/25 bg-red-400/[0.08]';

                return (
                  <div
                    key={g.clan_id}
                    className="group relative isolate overflow-hidden rounded-[22px] border border-white/[0.08] bg-gradient-to-br from-[#191313] via-[#141010] to-[#0d1110] p-5 sm:p-6 shadow-[0_18px_50px_rgba(0,0,0,0.2)] transition-all duration-200 hover:-translate-y-0.5 hover:border-[rgba(239,68,68,0.32)] hover:shadow-[0_22px_55px_rgba(0,0,0,0.28)]"
                  >
                    <div aria-hidden="true" className="pointer-events-none absolute -right-20 -top-28 h-64 w-64 rounded-full bg-[#14b8a6]/[0.06] blur-3xl transition-opacity group-hover:opacity-100" />
                    <div aria-hidden="true" className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-[#ef4444]/65 to-transparent" />
                    <div className="relative">
                      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-[15px] border border-[#ef4444]/20 bg-gradient-to-br from-[#ef4444]/[0.15] to-[#ef4444]/[0.04] text-[#ff8585] shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]">
                            <Shield size={21} />
                          </div>
                          <div className="min-w-0">
                            <button
                              type="button"
                              onClick={() => setSelectedClanId(g.clan_id)}
                              className="block max-w-full truncate text-left font-display text-[18px] font-extrabold text-[#f7f5f0] transition-colors hover:text-[#ff8585] cursor-pointer"
                            >
                              {g.name}
                            </button>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] font-mono-num text-[#a8a29e]">
                              <span>UID {g.clan_id}</span>
                              <button
                                type="button"
                                onClick={() => onCopyText(g.clan_id, 'Guild UID')}
                                className="grid h-5 w-5 place-items-center rounded-md text-[#a8a29e] transition-colors hover:bg-white/[0.06] hover:text-[#f7f5f0] cursor-pointer"
                                title="Copy Guild UID"
                              >
                                <Copy size={11} />
                              </button>
                              <span aria-hidden="true" className="text-white/20">·</span>
                              <span className="rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5">
                                {g.region || 'BD'}
                              </span>
                              <span className={`inline-flex items-center gap-1 font-sans font-bold ${
                                g.verified ? 'text-emerald-300' : 'text-amber-300'
                              }`}>
                                <BadgeCheck size={11} />
                                {g.verified ? 'Verified' : 'Sync Pending'}
                              </span>
                            </div>
                          </div>
                        </div>
                        <span className={`inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-[9px] font-extrabold tracking-[0.8px] ${statusTone}`}>
                          <span className={`h-1.5 w-1.5 rounded-full bg-current ${
                            statusText === 'ACTIVE' ? 'account-distribution-dot-active' : ''
                          }`} />
                          {statusText}
                        </span>
                      </div>

                      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                        <div className="rounded-[14px] border border-white/[0.07] bg-black/[0.18] p-3.5">
                          <div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.7px] text-[#a8a29e]">
                            <Clock size={13} className="text-amber-300" /> Active Time Left
                          </div>
                          <div className="font-mono-num text-[15px] font-extrabold text-[#f7f5f0]">
                            {rem === null ? 'Unlimited' : isExpired ? '00m 00s · Expired' : formatDuration(rem)}
                          </div>
                        </div>
                        <div className="rounded-[14px] border border-white/[0.07] bg-black/[0.18] p-3.5">
                          <div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.7px] text-[#a8a29e]">
                            <Users size={13} className="text-[#5eead4]" /> Squads
                          </div>
                          <div className="font-mono-num text-[15px] font-extrabold text-[#f7f5f0]">
                            {g.squad_count} <span className="font-sans text-[10px] font-semibold text-[#a8a29e]">configured</span>
                          </div>
                        </div>
                        <div className="rounded-[14px] border border-white/[0.07] bg-black/[0.18] p-3.5">
                          <div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.7px] text-[#a8a29e]">
                            <Bot size={13} className="text-emerald-300" /> Players in Guild
                          </div>
                          <div className="font-mono-num text-[15px] font-extrabold text-emerald-300">
                            {g.guild_joined_count}
                            <span className="mx-1 text-[#a8a29e]/60">/</span>
                            <span className="text-[#f7f5f0]">{g.player_count}</span>
                            <span className="ml-2 font-sans text-[10px] font-semibold text-[#a8a29e]">joined</span>
                          </div>
                        </div>
                      </div>

                      <div className="mt-4">
                        <div className="mb-1.5 flex items-center justify-between gap-2 text-[9px] font-bold uppercase tracking-[0.7px] text-[#a8a29e]">
                          <span>Guild Timer</span>
                          <span className="font-mono-num text-[#c8c2bd]">
                            {rem === null ? 'No expiry' : `${timePct.toFixed(0)}% remaining`}
                          </span>
                        </div>
                        <div
                          role="progressbar"
                          aria-label={`${g.name} active time remaining`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(timePct)}
                          className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]"
                        >
                          <span
                            className={`block h-full rounded-full transition-all duration-700 ${
                              statusText === 'ACTIVE'
                                ? 'bg-gradient-to-r from-emerald-600 to-emerald-300'
                                : statusText === 'PAUSED'
                                ? 'bg-gradient-to-r from-amber-600 to-amber-300'
                                : 'bg-gradient-to-r from-red-700 to-red-400'
                            }`}
                            style={{ width: `${timePct}%` }}
                          />
                        </div>
                      </div>

                      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-white/[0.07] pt-4">
                        <button
                          type="button"
                          onClick={() => setSelectedClanId(g.clan_id)}
                          className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-[#ef4444] to-[#dc2626] px-4 text-xs font-extrabold text-white shadow-[0_6px_20px_rgba(239,68,68,0.2)] transition-all hover:-translate-y-0.5 hover:shadow-[0_10px_26px_rgba(239,68,68,0.28)] cursor-pointer"
                        >
                          Open Squads ({g.squad_count})
                        </button>
                        <button
                          type="button"
                          onClick={() => openEditGuild(g)}
                          title="Edit Guild & Timer"
                          className="grid h-10 w-10 place-items-center rounded-xl border border-white/[0.09] bg-white/[0.03] text-[#a8a29e] transition-all hover:border-[#ef4444]/50 hover:bg-[#ef4444]/[0.08] hover:text-[#ff8585] cursor-pointer"
                        >
                          <Edit3 size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => void onUpdateGuild({ clan_id: g.clan_id, is_paused: !g.is_paused })}
                          title={g.is_paused ? 'Resume Guild' : 'Pause Guild'}
                          className="grid h-10 w-10 place-items-center rounded-xl border border-white/[0.09] bg-white/[0.03] text-[#a8a29e] transition-all hover:border-amber-400/40 hover:bg-amber-400/[0.08] hover:text-amber-300 cursor-pointer"
                        >
                          {g.is_paused ? <Play size={14} /> : <Pause size={14} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDelete({ type: 'guild', guild: g })}
                          title="Delete Guild"
                          className="grid h-10 w-10 place-items-center rounded-xl border border-white/[0.09] bg-white/[0.03] text-[#a8a29e] transition-all hover:border-red-400/45 hover:bg-red-400/[0.08] hover:text-red-300 cursor-pointer"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* LEVEL 2: SQUAD CARDS INSIDE SELECTED GUILD */}
      {activeGuild && !activeSquad && (
        <>
          {guildSquads.length === 0 ? (
            <div className="rounded-2xl bg-[#161010] border border-[rgba(239,68,68,0.16)] py-14 px-6 text-center">
              <Users size={36} className="mx-auto mb-3 text-emerald-400 opacity-60" />
              <p className="text-sm font-semibold text-[#f7f5f0] mb-1.5">
                No Squads inside {activeGuild.name} yet
              </p>
              <p className="text-xs text-[#a8a29e] mb-5 max-w-md mx-auto">
                Create a Squad of 2, 3, or 4 players (or auto-split 5–12 bots into multiple squads). Each squad groups strictly with its own players.
              </p>
              <button
                type="button"
                onClick={openCreateSquadModal}
                className="h-10 px-5 rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-400 text-[#080000] text-xs font-extrabold inline-flex items-center gap-2 cursor-pointer"
              >
                <Plus size={14} />
                Create Squad
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {guildSquads.map((sq) => {
                const members = getOrderedSquadPlayers(accounts, sq);
                return (
                  <div
                    key={sq.id}
                    className="rounded-2xl bg-[#161010] border border-[rgba(239,68,68,0.18)] hover:border-[rgba(239,68,68,0.45)] transition-colors p-5"
                  >
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="min-w-0">
                        <button
                          type="button"
                          onClick={() => setSelectedSquadId(sq.id)}
                          className="text-left font-display text-lg font-extrabold text-[#f7f5f0] hover:text-[#ef4444] transition-colors truncate block max-w-full cursor-pointer"
                        >
                          {sq.name}
                        </button>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-[#a8a29e] mt-0.5">
                          <span className="font-bold text-[#f7f5f0]">
                            {GAME_MODE_LABELS[normalizeGameMode(sq.game_mode)]}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono-num">Size {sq.target_size}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono-num">Instant start</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono-num">{sq.bot_prefix || 'RDX'}•</span>
                          {sq.team_code && (
                            <>
                              <span aria-hidden="true">·</span>
                              <button
                                type="button"
                                onClick={() => onCopyText(sq.team_code || '', 'Team Code')}
                                className="font-mono-num font-bold text-[#14b8a6] hover:underline cursor-pointer"
                              >
                                Code {sq.team_code}
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      <span
                        className={`text-[11px] font-mono-num font-extrabold shrink-0 ${
                          sq.status === 'IN MATCH'
                            ? 'text-[#14b8a6]'
                            : sq.status === 'SEARCHING' || sq.status === 'SQUAD READY'
                            ? 'text-emerald-400'
                            : sq.status === 'PAUSED'
                            ? 'text-amber-400'
                            : sq.status === 'NEEDS PLAYERS' || sq.status === 'SQUAD CREATING'
                            ? 'text-amber-400'
                            : 'text-[#a8a29e]'
                        }`}
                      >
                        {formatStatusText(
                          sq.status,
                          normalizeGameMode(sq.game_mode),
                        )}
                      </span>
                    </div>

                    <div className="border-t border-[rgba(239,68,68,0.12)] my-3.5 pt-3.5 space-y-2 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-[#a8a29e]">Players in Squad</span>
                        <span className="font-mono-num font-bold text-[#f7f5f0]">
                          {members.length} / {sq.target_size} Assigned
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[#a8a29e]">Guild Joined</span>
                        <span className="font-mono-num font-bold text-emerald-400">
                          {sq.guild_joined_count} / {members.length}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[#a8a29e]">Server-Confirmed In Group</span>
                        <span className="font-mono-num font-bold text-[#14b8a6]">
                          {sq.in_squad_count} / {members.length}
                        </span>
                      </div>
                      {members.length > 0 && (
                        <div className="pt-1 text-[11.5px] text-[#a8a29e] truncate">
                          Players: {members.map((m, index) => `${index + 1}. ${m.nickname}`).join(', ')}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2 pt-3 border-t border-[rgba(239,68,68,0.12)]">
                      <button
                        type="button"
                        onClick={() => setSelectedSquadId(sq.id)}
                        className="flex-1 h-9 px-3 rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-400 text-[#080000] text-xs font-extrabold whitespace-nowrap cursor-pointer"
                      >
                        Open Players ({members.length})
                      </button>
                      <button
                        type="button"
                        onClick={() => openEditSquadModal(sq)}
                        title="Edit Squad & Players"
                        className="w-9 h-9 rounded-xl bg-[#1e1515] border border-[rgba(239,68,68,0.18)] grid place-items-center text-[#a8a29e] hover:text-[#f7f5f0] hover:border-[#ef4444] cursor-pointer"
                      >
                        <Edit3 size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void onRestartSquad(sq.id)}
                        title="Restart Squad & Re-Group"
                        className="w-9 h-9 rounded-xl bg-[#1e1515] border border-[rgba(239,68,68,0.18)] grid place-items-center text-[#a8a29e] hover:text-[#f7f5f0] hover:border-[#ef4444] cursor-pointer"
                      >
                        <RefreshCw size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void onUpdateSquad({ squad_id: sq.id, is_paused: !sq.is_paused })}
                        title={sq.is_paused ? 'Resume Squad' : 'Pause Squad'}
                        className="w-9 h-9 rounded-xl bg-[#1e1515] border border-[rgba(239,68,68,0.18)] grid place-items-center text-[#a8a29e] hover:text-[#f7f5f0] hover:border-[#ef4444] cursor-pointer"
                      >
                        {sq.is_paused ? <Play size={14} /> : <Pause size={14} />}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete({ type: 'squad', squad: sq })}
                        title="Delete Squad"
                        className="w-9 h-9 rounded-xl bg-[#1e1515] border border-[rgba(239,68,68,0.18)] grid place-items-center text-[#a8a29e] hover:text-[#ef4444] hover:border-[#ef4444] cursor-pointer"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* LEVEL 3: PLAYERS INSIDE SELECTED SQUAD */}
      {activeGuild && activeSquad && (
        <div className="space-y-4">
          {(() => {
            const steps = getSquadFlowSteps(activeSquad, squadPlayers);
            const completedMatches = activeSquad.completed_matches_in_cycle || 0;
            const resetThreshold = activeSquad.match_reset_threshold || 10;
            const cycleProgress = Math.min(100, (completedMatches / resetThreshold) * 100);
            const playerStatuses = squadPlayers.map((player) => String(player.status || '').toUpperCase());
            const liveMatch = activeSquad.in_match_count > 0 || playerStatuses.includes('IN_MATCH');
            const joiningGame =
              (activeSquad.match_recovering_count || 0) > 0 || playerStatuses.includes('MATCH_RESUMING');
            const retryPending =
              playerStatuses.includes('MATCH_CANCELLED') || activeSquad.status === 'MATCH RETRY';
            const processingMatch =
              playerStatuses.some((status) => ['START_MATCH', 'SEARCHING', 'MATCHING'].includes(status)) ||
              activeSquad.status === 'SEARCHING';
            const currentStatus = liveMatch
              ? 'In Game'
              : joiningGame
                ? 'Joining Game'
                : retryPending
                  ? 'Retry Pending'
                  : processingMatch
                    ? 'REQUEST UNCONFIRMED'
              : activeSquad.status === 'SQUAD READY'
                ? 'Squad Ready'
                : formatStatusText(activeSquad.status, normalizeGameMode(activeSquad.game_mode));

            return (
              <section
                aria-label="Squad match progress"
                className="relative isolate overflow-hidden rounded-[24px] border border-white/[0.08] bg-[linear-gradient(135deg,rgba(24,16,19,0.98),rgba(14,18,24,0.98)_58%,rgba(12,21,24,0.98))] p-4 shadow-[0_22px_60px_rgba(0,0,0,0.28)] sm:p-6"
              >
                <div className="pointer-events-none absolute -right-10 -top-20 -z-10 h-48 w-48 rounded-full bg-emerald-400/[0.08] blur-3xl" />
                <div className="pointer-events-none absolute -left-16 bottom-0 -z-10 h-44 w-44 rounded-full bg-red-500/[0.08] blur-3xl" />

                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <span className="grid h-11 w-11 place-items-center rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.08] text-emerald-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
                      <Activity size={19} />
                    </span>
                    <div>
                      <p className="text-[9px] font-extrabold uppercase tracking-[0.2em] text-emerald-300/80">
                        Live squad workflow
                      </p>
                      <h3 className="mt-0.5 text-base font-extrabold text-[#f7f5f0] sm:text-lg">
                        Ranked Match Flow
                      </h3>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-[0.12em] ${
                        liveMatch
                          ? 'border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300'
                          : joiningGame
                            ? 'border-teal-300/25 bg-teal-300/[0.08] text-teal-200'
                          : retryPending
                              ? 'border-red-400/25 bg-red-400/[0.08] text-red-300'
                          : processingMatch
                            ? 'border-amber-300/25 bg-amber-300/[0.08] text-amber-200'
                            : 'border-white/[0.1] bg-white/[0.04] text-[#c7c3be]'
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${
                        liveMatch
                          ? 'bg-emerald-300'
                          : joiningGame
                            ? 'bg-teal-200 animate-pulse'
                            : retryPending
                              ? 'bg-red-300 animate-pulse'
                              : processingMatch
                                ? 'bg-amber-200 animate-pulse'
                                : 'bg-stone-400'
                      }`} />
                      {currentStatus}
                    </span>
                    <span className="rounded-full border border-amber-300/20 bg-amber-300/[0.07] px-3 py-1.5 font-mono-num text-[10px] font-bold text-amber-200">
                      {completedMatches}/{resetThreshold} matches
                    </span>
                  </div>
                </div>

                <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-teal-300 to-amber-300 transition-[width] duration-700"
                    style={{ width: `${cycleProgress}%` }}
                  />
                </div>

                <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-5">
                  {steps.map((step, index) => (
                    <div
                      key={step.title}
                      aria-current={step.state === 'active' || step.state === 'failed' || step.state === 'live' ? 'step' : undefined}
                      className={`relative min-w-0 rounded-2xl border p-3.5 transition-colors ${
                        step.state === 'done' || step.state === 'live'
                          ? 'border-emerald-400/20 bg-emerald-400/[0.045]'
                          : step.state === 'failed'
                            ? 'border-red-400/30 bg-red-400/[0.06]'
                            : step.state === 'active'
                              ? 'border-amber-300/25 bg-amber-300/[0.045]'
                              : 'border-white/[0.07] bg-black/[0.12]'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <span
                          className={`grid h-7 w-7 shrink-0 place-items-center rounded-xl border text-[10px] font-extrabold ${
                            step.state === 'done' || step.state === 'live'
                              ? 'border-emerald-300/25 bg-emerald-300/10 text-emerald-200'
                              : step.state === 'failed'
                                ? 'border-red-300/25 bg-red-300/10 text-red-200'
                                : step.state === 'active'
                                  ? 'border-amber-300/25 bg-amber-300/10 text-amber-200'
                                  : 'border-white/[0.08] bg-white/[0.03] text-[#8f8a86]'
                          }`}
                        >
                          {step.state === 'done' ? <Check size={12} /> : step.state === 'live' ? <Activity size={12} /> : index + 1}
                        </span>
                        <div className="min-w-0">
                          <span className="block truncate text-[11px] font-extrabold text-[#f7f5f0]">
                            {step.title}
                          </span>
                          <span
                            className={`mt-0.5 block text-[8px] font-extrabold uppercase tracking-[0.16em] ${
                              step.state === 'done' || step.state === 'live'
                                ? 'text-emerald-300/80'
                                : step.state === 'failed'
                                  ? 'text-red-300/80'
                                  : step.state === 'active'
                                    ? 'text-amber-200/80'
                                    : 'text-[#77716d]'
                            }`}
                          >
                            {step.state === 'done'
                              ? step.title === 'Match Start' ? 'Match Start' : 'Complete'
                              : step.state === 'live'
                                ? 'In Game'
                                : step.state === 'failed'
                                  ? 'Cancelled'
                                  : step.state === 'active'
                                    ? step.title === 'Match Start'
                                      ? 'Unconfirmed'
                                      : step.title === 'Ranked Search'
                                        ? 'Awaiting confirmation'
                                        : step.title === 'In Game'
                                          ? 'Joining Game'
                                          : 'In Progress'
                                    : 'Waiting'}
                          </span>
                        </div>
                      </div>
                      <p className="mt-3 min-h-8 text-[10px] leading-relaxed text-[#a8a29e]">{step.detail}</p>
                      {step.timer && (
                        <div className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-amber-300/15 bg-amber-300/[0.05] px-2 py-1 text-[9px] font-bold text-amber-100/80">
                          <Clock size={10} />
                          <span>{step.timer.label}</span>
                          <time className="font-mono-num text-[10px] font-extrabold tabular-nums text-amber-200">
                            {step.timer.value}
                          </time>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-[9px] text-[#77716d]">
                  Group remains intact between matches and is recreated after {resetThreshold} completed matches.
                </p>
              </section>
            );
          })()}

          <section className="relative overflow-hidden rounded-[24px] border border-white/[0.08] bg-[linear-gradient(145deg,rgba(24,16,19,0.96),rgba(17,19,24,0.96))] p-4 shadow-[0_18px_48px_rgba(0,0,0,0.2)] sm:p-5">
            <div className="pointer-events-none absolute -right-16 -top-20 h-40 w-40 rounded-full bg-red-500/[0.07] blur-3xl" />
            <div className="relative flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-xl border border-red-400/20 bg-red-400/[0.08] text-red-200">
                  <Users size={17} />
                </span>
                <div>
                  <p className="text-[9px] font-extrabold uppercase tracking-[0.18em] text-[#9c9591]">
                    Squad telemetry
                  </p>
                  <h3 className="text-sm font-extrabold text-[#f7f5f0]">
                    {activeSquad.name}
                    <span className="ml-2 text-[10px] font-semibold text-[#928b87]">
                      {activeSquad.target_size} player roster
                    </span>
                  </h3>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-black/20 px-2.5 py-1.5 text-[9px] font-bold text-[#c8c2bd]">
                  <span className="text-[#8f8985]">PREFIX</span>
                  <span className="font-mono-num text-[#f7f5f0]">{activeSquad.bot_prefix || 'RDX'}•</span>
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/15 bg-emerald-400/[0.05] px-2.5 py-1.5 text-[9px] font-extrabold uppercase tracking-wider text-emerald-200">
                  <Activity size={11} />
                  {activeSquad.status === 'SQUAD READY'
                    ? 'Squad Ready'
                    : formatStatusText(activeSquad.status, normalizeGameMode(activeSquad.game_mode))}
                </span>
              </div>
            </div>

            <div className="relative mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
              <div className="rounded-2xl border border-white/[0.07] bg-black/[0.16] p-3">
                <div className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.12em] text-[#8f8985]">
                  <Shield size={12} className="text-emerald-300" /> Guild Joined
                </div>
                <div className="mt-2 flex items-baseline gap-1.5">
                  <strong className="font-mono-num text-lg font-black text-[#f7f5f0]">
                    {activeSquad.guild_joined_count}
                  </strong>
                  <span className="text-[10px] text-[#77716d]">/ {activeSquad.target_size}</span>
                </div>
                <p className="mt-0.5 truncate text-[9px] text-[#8f8985]">{activeGuild.name}</p>
              </div>

              <div className="rounded-2xl border border-white/[0.07] bg-black/[0.16] p-3">
                <div className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.12em] text-[#8f8985]">
                  <Users size={12} className="text-teal-300" /> In Squad
                </div>
                <div className="mt-2 flex items-baseline gap-1.5">
                  <strong className="font-mono-num text-lg font-black text-[#f7f5f0]">
                    {activeSquad.in_squad_count}
                  </strong>
                  <span className="text-[10px] text-[#77716d]">/ {activeSquad.target_size}</span>
                </div>
                <p className="mt-0.5 text-[9px] text-[#8f8985]">server-confirmed players</p>
              </div>

              <div className="rounded-2xl border border-teal-300/15 bg-teal-300/[0.035] p-3">
                <div className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.12em] text-[#8f8985]">
                  <Copy size={12} className="text-teal-200" /> Team Code
                </div>
                <div className="mt-2 flex min-w-0 items-center gap-1.5">
                  <strong className="min-w-0 truncate font-mono-num text-base font-black tracking-[0.08em] text-teal-100">
                    {activeSquad.team_code || 'Pending'}
                  </strong>
                  {activeSquad.team_code && (
                    <button
                      type="button"
                      onClick={() => onCopyText(activeSquad.team_code || '', 'Team Code')}
                      aria-label="Copy team code"
                      className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-teal-100/70 hover:bg-teal-300/10 hover:text-teal-100"
                    >
                      <Copy size={11} />
                    </button>
                  )}
                </div>
                <p className="mt-0.5 text-[9px] text-[#8f8985]">
                  {activeSquad.leader_uid ? `Leader UID ${activeSquad.leader_uid}` : 'Waiting for leader'}
                </p>
              </div>

              <div className="rounded-2xl border border-white/[0.07] bg-black/[0.16] p-3">
                <div className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.12em] text-[#8f8985]">
                  <Server size={12} className="text-amber-200" /> Server Config
                </div>
                <strong className="mt-2 block truncate text-sm font-extrabold text-[#f7f5f0]">
                  {activeGuild.region || 'BD'} · {GAME_MODE_LABELS[normalizeGameMode(activeSquad.game_mode)]}
                </strong>
                <p className="mt-1 flex items-center gap-1 text-[9px] text-[#8f8985]">
                  <Globe2 size={10} /> {activeGuild.verified ? 'Guild verified' : 'Guild sync pending'}
                  {activeGuild.verified && <BadgeCheck size={10} className="text-emerald-300" />}
                </p>
              </div>

              <div className="col-span-2 rounded-2xl border border-white/[0.07] bg-black/[0.16] p-3 sm:col-span-1">
                <div className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.12em] text-[#8f8985]">
                  <Activity size={12} className="text-red-200" /> Match Mode
                </div>
                <div className="mt-2 inline-flex rounded-lg border border-white/[0.08] bg-black/20 p-0.5">
                  {(['BR_RANK', 'CS_RANK'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => void onUpdateSquad({ squad_id: activeSquad.id, game_mode: mode })}
                      aria-pressed={normalizeGameMode(activeSquad.game_mode) === mode}
                      className={`rounded-md px-2 py-1 text-[9px] font-extrabold transition-colors ${
                        normalizeGameMode(activeSquad.game_mode) === mode
                          ? 'bg-red-500/80 text-white shadow-[0_3px_10px_rgba(239,68,68,0.2)]'
                          : 'text-[#8f8985] hover:text-white'
                      }`}
                    >
                      {mode === 'BR_RANK' ? 'BR' : 'CS'}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-[9px] text-[#8f8985]">Starts when the roster is ready</p>
              </div>
            </div>
          </section>

          {squadPlayers.length === 0 ? (
            <div className="rounded-2xl bg-[#161010] border border-[rgba(239,68,68,0.14)] py-12 px-5 text-center text-[#a8a29e]">
              <Bot size={32} className="mx-auto mb-2.5 text-[#ef4444] opacity-50" />
              <p className="text-sm font-semibold mb-3">
                {creating ? 'Registering & connecting bots to this squad...' : 'No players assigned to this squad yet.'}
              </p>
              <button
                type="button"
                onClick={() => openEditSquadModal(activeSquad)}
                className="h-9 px-4 rounded-xl bg-gradient-to-br from-[#ef4444] to-[#dc2626] text-[#f7f5f0] text-xs font-bold cursor-pointer"
              >
                Add Player to Squad
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {squadPlayers.map((acc) => {
                const cat = normalizeCategory(acc);
                const statusText = acc.is_paused
                  ? 'Paused'
                  : formatStatusText(acc.status || 'ONLINE', activeSquad.game_mode);
                const lobbyWaitSeconds = Math.max(
                  0,
                  Math.ceil(((Number(activeSquad.next_match_at) || 0) - Date.now()) / 1000),
                );
                const squadSlot = squadPlayers.findIndex((player) => player.uid === acc.uid) + 1;
                const isFixedLeader = squadSlot === 1;
                const matches = acc.matches ?? acc.matches_played ?? 0;
                const exp = acc.current_exp ?? acc.exp ?? 0;

                return (
                  <div
                    key={acc.uid}
                    className="group relative overflow-hidden rounded-[24px] border border-white/[0.08] bg-[linear-gradient(145deg,rgba(25,18,20,0.96),rgba(17,19,24,0.96))] p-4 transition duration-300 hover:-translate-y-0.5 hover:border-red-300/20 hover:shadow-[0_18px_40px_rgba(0,0,0,0.25)] sm:p-5"
                  >
                    <div className="pointer-events-none absolute -right-10 -top-14 h-32 w-32 rounded-full bg-teal-300/[0.06] blur-3xl transition group-hover:bg-teal-300/[0.1]" />
                    <div className="relative flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="relative grid h-14 w-14 shrink-0 place-items-center rounded-2xl border border-white/[0.1] bg-gradient-to-br from-red-400/15 to-teal-300/10">
                          {acc.avatar && (
                            <img
                              src={acc.avatar}
                              alt=""
                              className="absolute inset-0 z-10 h-full w-full rounded-2xl object-cover"
                              onError={(event) => {
                                event.currentTarget.style.display = 'none';
                              }}
                            />
                          )}
                          <UserRound size={20} className="relative z-0 text-[#aaa29e]" />
                          <span className="absolute -bottom-1.5 -right-1.5 grid h-6 w-6 place-items-center rounded-lg border-2 border-[#171416] bg-[#2b2023] text-[9px] font-black text-[#f7f5f0]">
                            {squadSlot}
                          </span>
                        </div>
                        <div className="min-w-0">
                          <p className="text-[8px] font-extrabold uppercase tracking-[0.18em] text-[#8f8985]">
                            Player profile
                          </p>
                          <div className="mt-1 flex min-w-0 items-center gap-2">
                            <h4 className="truncate text-sm font-extrabold text-[#f7f5f0]">
                              {acc.nickname || 'Unknown'}
                            </h4>
                            {isFixedLeader && (
                              <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-300/20 bg-amber-300/[0.07] px-1.5 py-0.5 text-[8px] font-extrabold uppercase tracking-wider text-amber-200">
                                <Crown size={9} /> Leader
                              </span>
                            )}
                          </div>
                          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-[#9c9591]">
                            <span className="font-mono-num">UID {acc.uid}</span>
                            <button
                              type="button"
                              onClick={() => onCopyText(acc.uid, 'Player UID')}
                              aria-label={`Copy UID ${acc.uid}`}
                              className="rounded p-0.5 text-[#8f8985] hover:bg-white/[0.06] hover:text-white"
                            >
                              <Copy size={10} />
                            </button>
                            <span className="text-[#5f5a57]">·</span>
                            <span className="font-mono-num">Lv {acc.level || 1}</span>
                          </div>
                        </div>
                      </div>
                      <div
                        className={`inline-flex shrink-0 items-center gap-1.5 rounded-xl border px-2.5 py-2 text-right text-[9px] font-extrabold uppercase tracking-wider ${
                          cat === 'match'
                            ? 'border-teal-300/20 bg-teal-300/[0.07] text-teal-200'
                            : cat === 'online'
                              ? 'border-emerald-300/20 bg-emerald-300/[0.06] text-emerald-200'
                              : cat === 'search' || cat === 'paused'
                                ? 'border-amber-300/20 bg-amber-300/[0.06] text-amber-200'
                                : 'border-red-300/20 bg-red-300/[0.06] text-red-200'
                        }`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${cat === 'match' ? 'bg-teal-200' : cat === 'online' ? 'bg-emerald-200' : cat === 'search' || cat === 'paused' ? 'bg-amber-200' : 'bg-red-200'}`} />
                        <span>{statusText}</span>
                      </div>
                    </div>

                    <div className="relative mt-4 grid grid-cols-2 gap-2">
                      <div className="rounded-xl border border-white/[0.06] bg-black/[0.14] p-2.5">
                        <div className="flex items-center gap-1.5 text-[8px] font-extrabold uppercase tracking-[0.12em] text-[#85807c]">
                          <Shield size={10} /> Guild
                        </div>
                        <p className="mt-1 truncate text-[10px] font-bold text-[#e8e4df]">
                          {acc.clan_name || acc.clan_id || 'Unassigned'}
                        </p>
                        <p className={`mt-0.5 text-[8px] font-bold ${acc.guild_joined ? 'text-emerald-300' : 'text-amber-300'}`}>
                          {acc.guild_joined ? 'Joined' : 'Pending'}
                        </p>
                      </div>
                      <div className="rounded-xl border border-white/[0.06] bg-black/[0.14] p-2.5">
                        <div className="flex items-center gap-1.5 text-[8px] font-extrabold uppercase tracking-[0.12em] text-[#85807c]">
                          <Users size={10} /> Squad
                        </div>
                        <p className="mt-1 truncate text-[10px] font-bold text-[#e8e4df]">
                          {acc.squad_name || activeSquad.name}
                        </p>
                        <p className={`mt-0.5 text-[8px] font-bold ${acc.in_squad ? 'text-teal-200' : 'text-[#85807c]'}`}>
                          {acc.in_squad ? 'Server-confirmed in group' : 'Waiting for group'}
                        </p>
                      </div>
                      <div className="col-span-2 grid grid-cols-3 divide-x divide-white/[0.06] rounded-xl border border-white/[0.06] bg-black/[0.14] py-2.5">
                        <div className="px-2.5">
                          <p className="text-[8px] font-bold uppercase tracking-wider text-[#85807c]">Matches</p>
                          <p className="mt-1 font-mono-num text-[11px] font-extrabold text-[#f7f5f0]">{matches}</p>
                        </div>
                        <div className="px-2.5">
                          <p className="text-[8px] font-bold uppercase tracking-wider text-[#85807c]">EXP</p>
                          <p className="mt-1 truncate font-mono-num text-[11px] font-extrabold text-[#f7f5f0]">{Number(exp).toLocaleString()}</p>
                        </div>
                        <div className="px-2.5">
                          <p className="text-[8px] font-bold uppercase tracking-wider text-[#85807c]">Uptime</p>
                          <p className="mt-1 truncate font-mono-num text-[11px] font-extrabold text-[#f7f5f0]">
                            {formatDuration(acc.uptime_seconds || 0)}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-end gap-2 mt-4 pt-3 border-t border-[rgba(239,68,68,0.12)]">
                      {lobbyWaitSeconds > 0 && (
                        <span
                          aria-live="polite"
                          className="mr-auto inline-flex items-center gap-1.5 rounded-lg border border-amber-300/20 bg-amber-300/[0.07] px-2.5 py-1.5 text-[9px] font-extrabold uppercase tracking-wider text-amber-200"
                        >
                          <Clock size={11} />
                          Lobby
                          <time className="font-mono-num text-[11px] tabular-nums">
                            {formatDuration(lobbyWaitSeconds)}
                          </time>
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => void onTogglePauseBot(acc.uid)}
                        title={acc.is_paused ? 'Resume' : 'Pause'}
                        className="h-8 px-3 rounded-lg bg-[#1e1515] border border-[rgba(239,68,68,0.18)] text-xs font-bold inline-flex items-center gap-1.5 text-[#a8a29e] hover:text-[#f7f5f0] cursor-pointer"
                      >
                        {acc.is_paused ? <Play size={12} /> : <Pause size={12} />}
                        {acc.is_paused ? 'Resume' : 'Pause'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void onRestartBot(acc.uid)}
                        title="Restart Bot"
                        className="h-8 px-3 rounded-lg bg-[#1e1515] border border-[rgba(239,68,68,0.18)] text-xs font-bold inline-flex items-center gap-1.5 text-[#a8a29e] hover:text-[#f7f5f0] cursor-pointer"
                      >
                        <RefreshCw size={12} />
                        Restart
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void onUpdateSquad({
                            squad_id: activeSquad.id,
                            remove_uids: [acc.uid],
                          })
                        }
                        title="Remove from Squad"
                        className="h-8 px-3 rounded-lg bg-[#1e1515] border border-[rgba(239,68,68,0.18)] text-xs font-bold inline-flex items-center gap-1.5 text-amber-400 hover:border-amber-400 cursor-pointer"
                      >
                        <UserMinus size={12} />
                        Remove
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteBot(acc.uid, acc.auth_uid)}
                        title="Delete Account"
                        className="h-8 w-8 rounded-lg bg-[#1e1515] border border-[rgba(239,68,68,0.18)] grid place-items-center text-[#a8a29e] hover:text-[#ef4444] cursor-pointer"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* CREATE / EDIT GUILD MODAL */}
      {guildModal.open && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-5 bg-black/75 backdrop-blur-md"
          onClick={(e) => {
            if (e.target === e.currentTarget) setGuildModal({ open: false, editing: null });
          }}
        >
          <div className="w-full max-w-[460px] rounded-t-[22px] sm:rounded-[22px] bg-[#161010] border border-[rgba(239,68,68,0.35)] p-7 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-extrabold">
                {guildModal.editing ? 'Edit Guild & Timer' : 'Create Guild'}
              </h2>
              <button
                type="button"
                onClick={() => setGuildModal({ open: false, editing: null })}
                className="w-8 h-8 rounded-lg grid place-items-center text-[#a8a29e] hover:text-[#ef4444] cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleGuildSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-[#a8a29e] mb-1.5">
                  Guild UID
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={gUid}
                    disabled={Boolean(guildModal.editing)}
                    onChange={(e) => setGUid(e.target.value)}
                    onBlur={() => {
                      if (!guildModal.editing) void handleLookupClan(gUid);
                    }}
                    placeholder="e.g. 3106921760"
                    className="flex-1 h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.18)] font-mono-num text-sm outline-none focus:border-[#ef4444] disabled:opacity-60"
                  />
                  {!guildModal.editing && (
                    <button
                      type="button"
                      onClick={() => void handleLookupClan(gUid)}
                      className="h-11 px-3.5 rounded-xl bg-[#1e1515] border border-[rgba(239,68,68,0.25)] text-xs font-bold inline-flex items-center gap-1.5 hover:border-[#ef4444] cursor-pointer"
                    >
                      <Search size={13} />
                      {lookupState === 'loading' ? 'Checking...' : 'Search'}
                    </button>
                  )}
                </div>
                {lookupState === 'verified' && (
                  <p className="text-[11px] text-emerald-400 mt-1">
                    Verified real Guild Name from BD server.
                  </p>
                )}
                {lookupState === 'manual' && (
                  <p className="text-[11px] text-[#a8a29e] mt-1">
                    Could not verify this Guild UID. Enter the Guild Name manually, check that the UID is correct and a bot is connected, then retry.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs font-bold text-[#a8a29e] mb-1.5">
                  Guild Name
                </label>
                <input
                  type="text"
                  value={gName}
                  onChange={(e) => setGName(e.target.value)}
                  placeholder="Real Guild Name (auto-filled if online)"
                  className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.18)] text-sm outline-none focus:border-[#ef4444]"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-[#a8a29e] mb-1.5">
                  Active Duration (0 / 0 / 0 = Unlimited)
                </label>
                <div className="grid grid-cols-3 gap-2.5">
                  <div>
                    <span className="block text-[11px] text-[#a8a29e] mb-1">Days</span>
                    <input
                      type="number"
                      min={0}
                      max={365}
                      value={gDays}
                      onChange={(e) => setGDays(Math.max(0, Number(e.target.value || 0)))}
                      className="w-full h-10 px-3 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.18)] font-mono-num text-sm outline-none focus:border-[#ef4444]"
                    />
                  </div>
                  <div>
                    <span className="block text-[11px] text-[#a8a29e] mb-1">Hours</span>
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={gHours}
                      onChange={(e) => setGHours(Math.max(0, Number(e.target.value || 0)))}
                      className="w-full h-10 px-3 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.18)] font-mono-num text-sm outline-none focus:border-[#ef4444]"
                    />
                  </div>
                  <div>
                    <span className="block text-[11px] text-[#a8a29e] mb-1">Minutes</span>
                    <input
                      type="number"
                      min={0}
                      max={59}
                      value={gMinutes}
                      onChange={(e) => setGMinutes(Math.max(0, Number(e.target.value || 0)))}
                      className="w-full h-10 px-3 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.18)] font-mono-num text-sm outline-none focus:border-[#ef4444]"
                    />
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setGuildModal({ open: false, editing: null })}
                  className="h-10 px-4 rounded-xl bg-[#1e1515] border border-[rgba(239,68,68,0.18)] text-xs font-bold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={gSaving || !/^\d+$/.test(gUid.trim())}
                  className="h-10 px-4 rounded-xl bg-gradient-to-br from-[#ef4444] to-[#dc2626] text-[#f7f5f0] text-xs font-extrabold cursor-pointer disabled:opacity-50"
                >
                  {gSaving ? 'Saving...' : guildModal.editing ? 'Save Changes' : 'Create Guild'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CREATE SQUAD MODAL */}
      {squadModalOpen && activeGuild && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-5 bg-black/75 backdrop-blur-md"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSquadModalOpen(false);
          }}
        >
          <div className="w-full max-w-[480px] rounded-t-[22px] sm:rounded-[22px] bg-[#161010] border border-[rgba(239,68,68,0.35)] p-7 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-extrabold">
                Create Squad in {activeGuild.name}
              </h2>
              <button
                type="button"
                onClick={() => setSquadModalOpen(false)}
                className="w-8 h-8 rounded-lg grid place-items-center text-[#a8a29e] hover:text-[#ef4444] cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleCreateSquadSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-[#a8a29e] mb-1.5">
                  Squad Name
                </label>
                <input
                  type="text"
                  value={sqName}
                  onChange={(e) => setSqName(e.target.value)}
                  placeholder="Squad 1"
                  className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.18)] text-sm outline-none focus:border-[#ef4444]"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-[#a8a29e] mb-1.5">
                  Player Source
                </label>
                <div className="grid grid-cols-2 gap-2 p-1 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.16)]">
                  <button
                    type="button"
                    onClick={() => setSqMode('create_bots')}
                    className={`h-9 rounded-lg text-xs font-bold cursor-pointer ${
                      sqMode === 'create_bots'
                        ? 'bg-emerald-500 text-[#080000]'
                        : 'text-[#a8a29e] hover:text-[#f7f5f0]'
                    }`}
                  >
                    Create New Bots
                  </button>
                  <button
                    type="button"
                    onClick={() => setSqMode('assign_existing')}
                    className={`h-9 rounded-lg text-xs font-bold cursor-pointer ${
                      sqMode === 'assign_existing'
                        ? 'bg-emerald-500 text-[#080000]'
                        : 'text-[#a8a29e] hover:text-[#f7f5f0]'
                    }`}
                  >
                    Pick Existing Bots
                  </button>
                </div>
              </div>

              {sqMode === 'create_bots' ? (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-[#a8a29e] mb-1.5">
                      Players Count (2–12)
                    </label>
                    <input
                      type="number"
                      min={2}
                      max={12}
                      value={sqCount}
                      onChange={(e) => setSqCount(Math.max(2, Math.min(12, Number(e.target.value || 2))))}
                      className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.18)] font-mono-num text-sm outline-none focus:border-[#ef4444]"
                    />
                    {sqCount > 4 && (
                      <p className="text-[11px] text-emerald-400 mt-1">
                        Auto-splits into squads of 2–4 players.
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-[#a8a29e] mb-1.5">
                      Password
                    </label>
                    <input
                      type="text"
                      value={sqPassword}
                      onChange={(e) => setSqPassword(e.target.value)}
                      className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.18)] font-mono-num text-sm outline-none focus:border-[#ef4444]"
                    />
                  </div>
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-bold text-[#a8a29e] mb-1.5">
                    Select Players (2–4 per squad)
                  </label>
                  <div className="max-h-48 overflow-y-auto space-y-1.5 p-2 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.18)]">
                    {accounts.length === 0 ? (
                      <div className="py-6 text-center text-xs text-[#a8a29e]">
                        No accounts available yet. Switch to Create New Bots.
                      </div>
                    ) : (
                      accounts.map((a) => {
                        const checked = sqSelectedUids.includes(a.uid);
                        return (
                          <label
                            key={a.uid}
                            className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg hover:bg-white/5 cursor-pointer text-xs"
                          >
                            <span className="inline-flex items-center gap-2 min-w-0">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => {
                                  setSqSelectedUids((prev) =>
                                    prev.includes(a.uid)
                                      ? prev.filter((x) => x !== a.uid)
                                      : prev.length < 4
                                      ? [...prev, a.uid]
                                      : prev,
                                  );
                                }}
                              />
                              <span className="font-bold text-[#f7f5f0] truncate">{a.nickname}</span>
                              <span className="font-mono-num text-[#a8a29e]">{a.uid}</span>
                            </span>
                            <span className="text-[11px] text-[#a8a29e] shrink-0">
                              {a.squad_name || 'Unassigned'}
                            </span>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-[#a8a29e] mb-1.5">
                    Match Mode
                  </label>
                  <select
                    value={sqGameMode}
                    onChange={(e) => setSqGameMode(normalizeGameMode(e.target.value))}
                    className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.18)] text-sm outline-none focus:border-[#ef4444]"
                  >
                    <option value="BR_RANK">BR Rank</option>
                    <option value="CS_RANK">CS Rank</option>
                  </select>
                </div>
                <div className="flex flex-col justify-end">
                  <span className="block text-xs font-bold text-[#a8a29e] mb-1.5">Match Start</span>
                  <div className="flex h-11 items-center rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-3.5 text-sm font-bold text-emerald-400">
                    Immediate when squad is ready
                  </div>
                </div>
              </div>

              {sqMode === 'create_bots' && (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-xs font-bold text-[#a8a29e]">
                      Custom Bot Name Prefix
                    </label>
                    <span className="text-[11px] font-mono-num text-[#14b8a6]">
                      Preview: {cleanPrefix(sqBotPrefix)}•XXXXX
                    </span>
                  </div>
                  <input
                    type="text"
                    maxLength={6}
                    value={sqBotPrefix}
                    onChange={(e) => setSqBotPrefix(e.target.value.replace(/[^\w-]/g, '').slice(0, 6))}
                    placeholder="RDX"
                    className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.18)] font-mono-num text-sm outline-none focus:border-[#ef4444]"
                  />
                </div>
              )}

              <div className="flex justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setSquadModalOpen(false)}
                  className="h-10 px-4 rounded-xl bg-[#1e1515] border border-[rgba(239,68,68,0.18)] text-xs font-bold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={
                    sqSaving ||
                    (sqMode === 'assign_existing' && sqSelectedUids.length === 0)
                  }
                  className="h-10 px-4 rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-400 text-[#080000] text-xs font-extrabold cursor-pointer disabled:opacity-50"
                >
                  {sqSaving ? 'Creating...' : 'Create Squad'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* EDIT SQUAD MODAL */}
      {editSquad && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-5 bg-black/75 backdrop-blur-md"
          onClick={(e) => {
            if (e.target === e.currentTarget) setEditSquad(null);
          }}
        >
          <div className="w-full max-w-[460px] rounded-t-[22px] sm:rounded-[22px] bg-[#161010] border border-[rgba(239,68,68,0.35)] p-7 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-extrabold">Edit Squad</h2>
              <button
                type="button"
                onClick={() => setEditSquad(null)}
                className="w-8 h-8 rounded-lg grid place-items-center text-[#a8a29e] hover:text-[#ef4444] cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleEditSquadSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-[#a8a29e] mb-1.5">
                  Squad Name
                </label>
                <input
                  type="text"
                  value={editSqName}
                  onChange={(e) => setEditSqName(e.target.value)}
                  className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.18)] text-sm outline-none focus:border-[#ef4444]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-[#a8a29e] mb-1.5">
                    Squad Size
                  </label>
                  <select
                    value={editSqSize}
                    onChange={(e) => setEditSqSize(Number(e.target.value))}
                    className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.18)] text-sm outline-none focus:border-[#ef4444]"
                  >
                    <option value={2}>2 Players (Duo)</option>
                    <option value={3}>3 Players (Trio)</option>
                    <option value={4}>4 Players (Full Squad)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-[#a8a29e] mb-1.5">
                    Match Mode
                  </label>
                  <select
                    value={editSqGameMode}
                    onChange={(e) => setEditSqGameMode(normalizeGameMode(e.target.value))}
                    className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.18)] text-sm outline-none focus:border-[#ef4444]"
                  >
                    <option value="BR_RANK">BR Rank</option>
                    <option value="CS_RANK">CS Rank</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-[#a8a29e] mb-1.5">
                    Bot Name Prefix
                  </label>
                  <input
                    type="text"
                    maxLength={6}
                    value={editSqBotPrefix}
                    onChange={(e) => setEditSqBotPrefix(e.target.value.replace(/[^\w-]/g, '').slice(0, 6))}
                    className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.18)] font-mono-num text-sm outline-none focus:border-[#ef4444]"
                  />
                </div>
                <div className="flex flex-col justify-end">
                  <span className="block text-xs font-bold text-[#a8a29e] mb-1.5">Match Start</span>
                  <div className="flex h-11 items-center rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-3.5 text-sm font-bold text-emerald-400">
                    Immediate when squad is ready
                  </div>
                </div>
              </div>

              {unassignedOrMovableAccounts.length > 0 && (
                <div>
                  <label className="block text-xs font-bold text-[#a8a29e] mb-1.5">
                    Move / Add Existing Player into Squad
                  </label>
                  <select
                    value={addPlayerUid}
                    onChange={(e) => setAddPlayerUid(e.target.value)}
                    className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.18)] text-sm outline-none focus:border-[#ef4444]"
                  >
                    <option value="">— Optional: pick a player —</option>
                    {unassignedOrMovableAccounts.map((a) => (
                      <option key={a.uid} value={a.uid}>
                        {a.nickname} ({a.uid}) {a.squad_name ? `— from ${a.squad_name}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setEditSquad(null)}
                  className="h-10 px-4 rounded-xl bg-[#1e1515] border border-[rgba(239,68,68,0.18)] text-xs font-bold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={editSaving}
                  className="h-10 px-4 rounded-xl bg-gradient-to-br from-[#ef4444] to-[#dc2626] text-[#f7f5f0] text-xs font-extrabold cursor-pointer disabled:opacity-50"
                >
                  {editSaving ? 'Saving...' : 'Save Squad'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CONFIRM DELETE GUILD / SQUAD MODAL */}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-5 bg-black/75 backdrop-blur-md"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirmDelete(null);
          }}
        >
          <div className="w-full max-w-[440px] rounded-t-[22px] sm:rounded-[22px] bg-[#161010] border border-[rgba(239,68,68,0.35)] p-7 shadow-2xl">
            <h2 className="font-display text-lg font-extrabold mb-2">
              {confirmDelete.type === 'guild' ? 'Delete Guild?' : 'Delete Squad?'}
            </h2>
            <p className="text-xs text-[#a8a29e] leading-relaxed mb-5">
              {confirmDelete.type === 'guild'
                ? `Choose whether to delete Guild "${confirmDelete.guild.name}" (${confirmDelete.guild.clan_id}) along with its bot accounts, or keep the accounts unassigned.`
                : `Choose whether to remove only Squad "${confirmDelete.squad.name}" (keeping bots in Accounts) or also delete its bot accounts.`}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(null)}
                className="h-10 px-3.5 rounded-xl bg-[#1e1515] border border-[rgba(239,68,68,0.18)] text-xs font-bold cursor-pointer mr-auto"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const target = confirmDelete;
                  setConfirmDelete(null);
                  if (target.type === 'guild') {
                    await onDeleteGuild(target.guild.clan_id, false);
                  } else {
                    await onDeleteSquad(target.squad.id, false);
                  }
                }}
                className="h-10 px-3.5 rounded-xl bg-[#1e1515] border border-amber-500/40 text-amber-400 text-xs font-bold cursor-pointer"
              >
                Keep Bots
              </button>
              <button
                type="button"
                onClick={async () => {
                  const target = confirmDelete;
                  setConfirmDelete(null);
                  if (target.type === 'guild') {
                    await onDeleteGuild(target.guild.clan_id, true);
                  } else {
                    await onDeleteSquad(target.squad.id, true);
                  }
                }}
                className="h-10 px-3.5 rounded-xl bg-red-500/20 border border-red-500/45 text-[#ef4444] text-xs font-bold cursor-pointer"
              >
                Delete Everything
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ADD / REPLACE BOT IN EXISTING SQUAD MODAL */}
      {addBotModal && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-5 bg-black/75 backdrop-blur-md"
          onClick={(e) => {
            if (e.target === e.currentTarget) setAddBotModal(null);
          }}
        >
          <div className="w-full max-w-[440px] rounded-t-[22px] sm:rounded-[22px] bg-[#161010] border border-[rgba(239,68,68,0.35)] p-7 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-extrabold">
                Add / Replace Bot in {addBotModal.name}
              </h2>
              <button
                type="button"
                onClick={() => setAddBotModal(null)}
                className="w-8 h-8 rounded-lg grid place-items-center text-[#a8a29e] hover:text-[#ef4444] cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleAddBotToSquadSubmit} className="space-y-4">
              <p className="text-xs text-[#a8a29e] leading-relaxed">
                Create new guest bot(s) directly inside <strong className="text-[#f7f5f0]">{addBotModal.name}</strong> (Guild{' '}
                <span className="font-mono-num">{addBotModal.clan_id}</span>). Bots will auto-join the Guild and enter the same Squad group before starting a match.
              </p>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-[#a8a29e] mb-1.5">
                    New Bots Count (1–4)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={4}
                    value={addBotCount}
                    onChange={(e) => setAddBotCount(Math.max(1, Math.min(4, Number(e.target.value || 1))))}
                    className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.18)] font-mono-num text-sm outline-none focus:border-[#ef4444]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-[#a8a29e] mb-1.5">
                    Password
                  </label>
                  <input
                    type="text"
                    value={addBotPass}
                    onChange={(e) => setAddBotPass(e.target.value)}
                    className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.18)] font-mono-num text-sm outline-none focus:border-[#ef4444]"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs font-bold text-[#a8a29e]">
                    Bot Name Prefix
                  </label>
                  <span className="text-[11px] font-mono-num text-[#14b8a6]">
                    Preview: {cleanPrefix(addBotPrefix)}•XXXXX
                  </span>
                </div>
                <input
                  type="text"
                  maxLength={6}
                  value={addBotPrefix}
                  onChange={(e) => setAddBotPrefix(e.target.value.replace(/[^\w-]/g, '').slice(0, 6))}
                  placeholder="RDX"
                  className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.18)] font-mono-num text-sm outline-none focus:border-[#ef4444]"
                />
              </div>

              <div className="flex justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setAddBotModal(null)}
                  className="h-10 px-4 rounded-xl bg-[#1e1515] border border-[rgba(239,68,68,0.18)] text-xs font-bold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={addBotSaving}
                  className="h-10 px-4 rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-400 text-[#080000] text-xs font-extrabold cursor-pointer disabled:opacity-50"
                >
                  {addBotSaving ? 'Starting...' : 'Create & Join Squad'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
