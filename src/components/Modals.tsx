import React, { useEffect, useMemo, useState } from 'react';
import { Bolt, CheckCircle2, Loader2, Rocket, Search, Shield, Trash2, Users, X } from 'lucide-react';
import { GAME_MODE_LABELS, normalizeGameMode, type GameModeId, type GuildInfo, type SquadInfo } from '../types';

interface ModalShellProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

function ModalShell({ open, onClose, title, children }: ModalShellProps) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-5 bg-black/75 backdrop-blur-md"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-[490px] max-h-[92vh] overflow-y-auto rounded-t-[22px] sm:rounded-[22px] bg-[#161010] border border-[rgba(239,68,68,0.35)] p-6 sm:p-7 shadow-[0_30px_90px_rgba(0,0,0,0.8)]">
        <div className="flex items-center justify-between mb-1.5">
          <h2 className="font-display text-lg font-extrabold tracking-tight">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-[#a8a29e] hover:text-[#ef4444] hover:bg-red-500/10 transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function computeChunkSizes(total: number): number[] {
  const chunks: number[] = [];
  let rem = Math.max(2, Math.min(12, total));
  while (rem > 0) {
    if (rem <= 4) {
      chunks.push(rem);
      break;
    }
    if (rem === 5) {
      chunks.push(3, 2);
      break;
    }
    chunks.push(4);
    rem -= 4;
  }
  return chunks;
}

interface AddAccountModalProps {
  open: boolean;
  onClose: () => void;
  guilds: GuildInfo[];
  squads: SquadInfo[];
  onLookupClan?: (clanId: string) => Promise<{ found: boolean; name?: string; region?: string }>;
  onSubmit: (payload: {
    uid?: string;
    password?: string;
    token?: string;
    clan_id?: string;
    squad_id?: string;
  }) => Promise<void>;
}

export function AddAccountModal({
  open,
  onClose,
  guilds,
  squads,
  onLookupClan,
  onSubmit,
}: AddAccountModalProps) {
  const [accType, setAccType] = useState<'guest' | 'token'>('guest');
  const [uid, setUid] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [guildChoice, setGuildChoice] = useState<string>('__custom__');
  const [customClanId, setCustomClanId] = useState('');
  const [squadId, setSquadId] = useState<string>('__new__');
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupResult, setLookupResult] = useState<{ found: boolean; name?: string; region?: string } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (guilds.length > 0) {
      setGuildChoice(guilds[0].clan_id);
      setCustomClanId('');
    } else {
      setGuildChoice('__custom__');
    }
    setSquadId('__new__');
    setLookupResult(null);
  }, [open, guilds]);

  const effectiveClanId = guildChoice === '__custom__' ? customClanId.trim() : guildChoice;

  const guildSquads = useMemo(
    () => squads.filter((s) => s.clan_id === effectiveClanId),
    [squads, effectiveClanId],
  );
  const nextSquadNum = guildSquads.length + 1;

  const handleSearchClan = async () => {
    const cid = customClanId.trim();
    if (!cid || !/^\d+$/.test(cid) || !onLookupClan) return;
    setLookupBusy(true);
    try {
      const res = await onLookupClan(cid);
      setLookupResult(res);
    } finally {
      setLookupBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const targetPayload = {
        clan_id: effectiveClanId || undefined,
        squad_id: squadId,
      };
      if (accType === 'guest') {
        await onSubmit({ uid: uid.trim(), password: password.trim(), ...targetPayload });
      } else {
        await onSubmit({ token: token.trim(), ...targetPayload });
      }
      setUid('');
      setPassword('');
      setToken('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalShell open={open} onClose={onClose} title="Add Account">
      <form onSubmit={handleSubmit}>
        <p className="text-[#a8a29e] text-[13px] mb-4 leading-relaxed">
          Enter credentials and assign directly to a Guild &amp; Squad.
        </p>

        <div className="mb-3.5">
          <label className="block text-[10.5px] font-bold uppercase tracking-[1px] text-[#a8a29e] mb-1.5">
            Login Type
          </label>
          <select
            value={accType}
            onChange={(e) => setAccType(e.target.value as 'guest' | 'token')}
            className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.16)] text-sm font-medium outline-none focus:border-[#ef4444]"
          >
            <option value="guest">Guest (UID + Password)</option>
            <option value="token">Access Token</option>
          </select>
        </div>

        {accType === 'guest' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3.5">
            <div>
              <label className="block text-[10.5px] font-bold uppercase tracking-[1px] text-[#a8a29e] mb-1.5">
                Guest UID
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={uid}
                onChange={(e) => setUid(e.target.value)}
                placeholder="Enter UID"
                className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.16)] font-mono-num text-sm outline-none focus:border-[#ef4444]"
              />
            </div>
            <div>
              <label className="block text-[10.5px] font-bold uppercase tracking-[1px] text-[#a8a29e] mb-1.5">
                Password / Key
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.16)] font-mono-num text-sm outline-none focus:border-[#ef4444]"
              />
            </div>
          </div>
        ) : (
          <div className="mb-3.5">
            <label className="block text-[10.5px] font-bold uppercase tracking-[1px] text-[#a8a29e] mb-1.5">
              Access Token
            </label>
            <textarea
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste full token here..."
              rows={3}
              className="w-full p-3 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.16)] font-mono-num text-xs outline-none focus:border-[#ef4444] resize-y"
            />
          </div>
        )}

        <div className="mb-3.5">
          <label className="block text-[10.5px] font-bold uppercase tracking-[1px] text-[#a8a29e] mb-1.5">
            Target Guild
          </label>
          <select
            value={guildChoice}
            onChange={(e) => {
              setGuildChoice(e.target.value);
              setSquadId('__new__');
              setLookupResult(null);
            }}
            className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.16)] text-sm font-medium outline-none focus:border-[#ef4444]"
          >
            {guilds.map((g) => (
              <option key={g.clan_id} value={g.clan_id}>
                {g.name} ({g.clan_id}) · {g.squad_count} Squads · {g.player_count} Bots
              </option>
            ))}
            <option value="__custom__">+ Enter Custom Guild UID</option>
          </select>

          {guildChoice === '__custom__' && (
            <div className="mt-2">
              <div className="flex gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  value={customClanId}
                  onChange={(e) => {
                    setCustomClanId(e.target.value);
                    setLookupResult(null);
                  }}
                  placeholder="Enter Guild UID (e.g. 3106921760)"
                  className="flex-1 h-10 px-3 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.16)] font-mono-num text-xs outline-none focus:border-[#ef4444]"
                />
                {onLookupClan && (
                  <button
                    type="button"
                    onClick={handleSearchClan}
                    disabled={lookupBusy || !/^\d+$/.test(customClanId.trim())}
                    className="h-10 px-3 rounded-xl bg-[#1e1515] border border-[rgba(239,68,68,0.24)] hover:border-[#ef4444] text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    {lookupBusy ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
                    Search
                  </button>
                )}
              </div>
              {lookupResult && (
                <div
                  className={`mt-1.5 text-[11px] font-semibold flex items-center gap-1.5 ${
                    lookupResult.found ? 'text-emerald-400' : 'text-amber-400'
                  }`}
                >
                  <CheckCircle2 size={12} />
                  {lookupResult.found
                    ? `Verified: ${lookupResult.name || 'Clan'} · ${lookupResult.region || 'BD'}`
                    : 'Not verified yet — bots will still attempt join'}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mb-3.5">
          <label className="block text-[10.5px] font-bold uppercase tracking-[1px] text-[#a8a29e] mb-1.5">
            Target Squad
          </label>
          <select
            value={squadId}
            onChange={(e) => setSquadId(e.target.value)}
            className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.16)] text-sm font-medium outline-none focus:border-[#ef4444]"
          >
            <option value="__new__">+ New Squad (Will create Squad {nextSquadNum})</option>
            {guildSquads.map((sq, idx) => {
              const isFull = sq.member_uids.length >= 4;
              return (
                <option key={sq.id} value={sq.id} disabled={isFull}>
                  #{idx + 1} {sq.name} · {sq.member_uids.length}/{sq.target_size} players
                  {isFull ? ' (Full)' : ''}
                </option>
              );
            })}
          </select>
        </div>

        <div className="flex justify-end gap-2.5 mt-5">
          <button
            type="button"
            onClick={onClose}
            className="h-10 px-4 rounded-xl bg-[#1e1515] border border-[rgba(239,68,68,0.16)] text-[13px] font-bold hover:border-[rgba(239,68,68,0.38)] cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading}
            className="h-10 px-4 rounded-xl bg-gradient-to-br from-[#ef4444] to-[#dc2626] text-[#f7f5f0] text-[13px] font-bold inline-flex items-center gap-2 cursor-pointer disabled:opacity-60"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
            Save &amp; Start
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

interface CreateTeamModalProps {
  open: boolean;
  onClose: () => void;
  guilds: GuildInfo[];
  squads: SquadInfo[];
  onLookupClan?: (clanId: string) => Promise<{ found: boolean; name?: string; region?: string }>;
  onSubmit: (payload: {
    region: string;
    clan_id: string;
    squad_id?: string;
    squad_name?: string;
    game_mode: GameModeId;
    lobby_delay_sec: number;
    bot_prefix: string;
    count: number;
    password: string;
  }) => Promise<void>;
}

export function CreateTeamModal({
  open,
  onClose,
  guilds,
  squads,
  onLookupClan,
  onSubmit,
}: CreateTeamModalProps) {
  const [guildChoice, setGuildChoice] = useState<string>('__custom__');
  const [customClanId, setCustomClanId] = useState('3105458988');
  const [selectedSquadId, setSelectedSquadId] = useState<string>('__new__');
  const [squadName, setSquadName] = useState('');
  const [gameMode, setGameMode] = useState<GameModeId>('BR_RANK');
  const [botPrefix, setBotPrefix] = useState('RDX');
  const [count, setCount] = useState(4);
  const [password, setPassword] = useState('RDX771');
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupResult, setLookupResult] = useState<{ found: boolean; name?: string; region?: string } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (guilds.length > 0) {
      setGuildChoice(guilds[0].clan_id);
    } else {
      setGuildChoice('__custom__');
    }
    setSelectedSquadId('__new__');
    setSquadName('');
    setGameMode('BR_RANK');
    setBotPrefix('RDX');
    setCount(4);
    setLookupResult(null);
  }, [open, guilds]);

  const effectiveClanId = guildChoice === '__custom__' ? customClanId.trim() : guildChoice;
  const activeGuild = useMemo(
    () => guilds.find((g) => g.clan_id === effectiveClanId),
    [guilds, effectiveClanId],
  );
  const guildSquads = useMemo(
    () => squads.filter((s) => s.clan_id === effectiveClanId),
    [squads, effectiveClanId],
  );
  const nextSquadNumber = guildSquads.length + 1;
  const chosenExistingSquad = useMemo(
    () => (selectedSquadId !== '__new__' ? guildSquads.find((s) => s.id === selectedSquadId) : undefined),
    [guildSquads, selectedSquadId],
  );

  useEffect(() => {
    if (chosenExistingSquad) {
      setGameMode(normalizeGameMode(chosenExistingSquad.game_mode));
      setBotPrefix(chosenExistingSquad.bot_prefix || 'RDX');
    }
  }, [chosenExistingSquad]);

  const slotsRemaining = chosenExistingSquad
    ? Math.max(1, 4 - chosenExistingSquad.member_uids.length)
    : 12;

  useEffect(() => {
    if (chosenExistingSquad) {
      setCount((prev) => Math.max(1, Math.min(slotsRemaining, prev)));
    } else {
      setCount((prev) => Math.max(2, Math.min(12, prev)));
    }
  }, [chosenExistingSquad, slotsRemaining]);

  const cleanPrefix = (botPrefix || 'RDX').replace(/[^\w-]/g, '').slice(0, 6) || 'RDX';

  const splitPreview = useMemo(() => {
    const modeLabel = GAME_MODE_LABELS[gameMode];
    if (chosenExistingSquad) {
      const after = Math.min(4, chosenExistingSquad.member_uids.length + count);
      return `Adds ${count} bot(s) [${cleanPrefix}•***] into "${chosenExistingSquad.name}" (${chosenExistingSquad.member_uids.length} -> ${after}/4) · ${modeLabel} · immediate start`;
    }
    const chunks = computeChunkSizes(count);
    const parts = chunks.map((sz, idx) => {
      const label =
        idx === 0 && squadName.trim() ? squadName.trim() : `Squad ${nextSquadNumber + idx}`;
      return `${label} (${sz} bots)`;
    });
    return `${parts.join(' + ')} · ${modeLabel} · Prefix ${cleanPrefix}•*** · immediate start`;
  }, [chosenExistingSquad, cleanPrefix, count, gameMode, nextSquadNumber, squadName]);

  const handleSearchClan = async () => {
    const cid = customClanId.trim();
    if (!cid || !/^\d+$/.test(cid) || !onLookupClan) return;
    setLookupBusy(true);
    try {
      const res = await onLookupClan(cid);
      setLookupResult(res);
    } finally {
      setLookupBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await onSubmit({
        region: 'BD',
        clan_id: effectiveClanId,
        squad_id: selectedSquadId !== '__new__' ? selectedSquadId : undefined,
        squad_name: selectedSquadId === '__new__' && squadName.trim() ? squadName.trim() : undefined,
        game_mode: gameMode,
        lobby_delay_sec: 0,
        bot_prefix: cleanPrefix,
        count,
        password: password.trim() || 'RDX771',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalShell open={open} onClose={onClose} title="Create Team">
      <form onSubmit={handleSubmit}>
        <p className="text-[#a8a29e] text-[13px] mb-4 leading-relaxed">
          Choose live Guild &amp; Squad #, create bots, auto-join clan, and lock them into an isolated squad match loop.
        </p>

        {/* GUILD SELECTOR */}
        <div className="mb-3.5">
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-[10.5px] font-bold uppercase tracking-[1px] text-[#a8a29e]">
              Select Guild (Live)
            </label>
            {activeGuild && (
              <span className="text-[10.5px] font-bold text-emerald-400 inline-flex items-center gap-1">
                <Shield size={11} />
                {activeGuild.name} · {activeGuild.squad_count} Squads
              </span>
            )}
          </div>
          <select
            value={guildChoice}
            onChange={(e) => {
              setGuildChoice(e.target.value);
              setSelectedSquadId('__new__');
              setLookupResult(null);
            }}
            className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.16)] text-sm font-medium outline-none focus:border-[#ef4444]"
          >
            {guilds.map((g) => (
              <option key={g.clan_id} value={g.clan_id}>
                {g.name} (UID: {g.clan_id}) — {g.squad_count} Squads · {g.player_count} Bots
              </option>
            ))}
            <option value="__custom__">+ Enter Custom Guild UID</option>
          </select>

          {guildChoice === '__custom__' && (
            <div className="mt-2">
              <div className="flex gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  value={customClanId}
                  onChange={(e) => {
                    setCustomClanId(e.target.value);
                    setLookupResult(null);
                  }}
                  placeholder="Enter Guild UID (e.g. 3106921760)"
                  className="flex-1 h-10 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.16)] font-mono-num text-sm outline-none focus:border-[#ef4444]"
                />
                {onLookupClan && (
                  <button
                    type="button"
                    onClick={handleSearchClan}
                    disabled={lookupBusy || !/^\d+$/.test(customClanId.trim())}
                    className="h-10 px-3.5 rounded-xl bg-[#1e1515] border border-[rgba(239,68,68,0.28)] hover:border-[#ef4444] text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    {lookupBusy ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
                    Search
                  </button>
                )}
              </div>
              {lookupResult && (
                <div
                  className={`mt-1.5 text-[11px] font-semibold flex items-center gap-1.5 ${
                    lookupResult.found ? 'text-emerald-400' : 'text-amber-400'
                  }`}
                >
                  <CheckCircle2 size={12} />
                  {lookupResult.found
                    ? `Verified Guild: ${lookupResult.name || 'Clan'} (${lookupResult.region || 'BD'})`
                    : 'Not found in quick lookup — guild entry will still be created'}
                </div>
              )}
            </div>
          )}
        </div>

        {/* SQUAD SELECTOR */}
        <div className="mb-3.5">
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-[10.5px] font-bold uppercase tracking-[1px] text-[#a8a29e]">
              Target Squad #
            </label>
            <span className="text-[10.5px] font-mono-num text-[#a8a29e]">
              {guildSquads.length} active squad{guildSquads.length === 1 ? '' : 's'}
            </span>
          </div>
          <select
            value={selectedSquadId}
            onChange={(e) => setSelectedSquadId(e.target.value)}
            className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.16)] text-sm font-medium outline-none focus:border-[#ef4444]"
          >
            <option value="__new__">+ Create New Squad (Squad #{nextSquadNumber})</option>
            {guildSquads.map((sq, idx) => {
              const isFull = sq.member_uids.length >= 4;
              return (
                <option key={sq.id} value={sq.id} disabled={isFull}>
                  Squad #{idx + 1}: {sq.name} · {sq.member_uids.length}/{sq.target_size} players · {sq.status}
                  {isFull ? ' (Full)' : ''}
                </option>
              );
            })}
          </select>

          {selectedSquadId === '__new__' && (
            <input
              type="text"
              value={squadName}
              onChange={(e) => setSquadName(e.target.value)}
              placeholder={`Custom Squad Name (optional, default: Squad ${nextSquadNumber})`}
              className="mt-2 w-full h-10 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.16)] text-xs font-medium outline-none focus:border-[#ef4444]"
            />
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3.5">
          <div>
            <label className="block text-[10.5px] font-bold uppercase tracking-[1px] text-[#a8a29e] mb-1.5">
              Number of Bots
            </label>
            {chosenExistingSquad ? (
              <select
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.16)] text-sm font-medium outline-none focus:border-[#ef4444]"
              >
                {Array.from({ length: slotsRemaining }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    +{n} Bot{n > 1 ? 's' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <select
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.16)] text-sm font-medium outline-none focus:border-[#ef4444]"
              >
                <option value={2}>2 Bots (Duo Squad)</option>
                <option value={3}>3 Bots (Trio Squad)</option>
                <option value={4}>4 Bots (Full Squad)</option>
                <option value={5}>5 Bots (3 + 2 Split)</option>
                <option value={6}>6 Bots (4 + 2 Split)</option>
                <option value={7}>7 Bots (4 + 3 Split)</option>
                <option value={8}>8 Bots (2 Full Squads)</option>
                <option value={12}>12 Bots (3 Full Squads)</option>
              </select>
            )}
          </div>
          <div>
            <label className="block text-[10.5px] font-bold uppercase tracking-[1px] text-[#a8a29e] mb-1.5">
              Password (BD Region)
            </label>
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.16)] font-mono-num text-sm outline-none focus:border-[#ef4444]"
            />
          </div>
        </div>

        {/* GAME MODE & BOT PREFIX / LOBBY WAIT */}
        <div className="mb-3.5">
          <label className="block text-[10.5px] font-bold uppercase tracking-[1px] text-[#a8a29e] mb-1.5">
            Match Mode (Auto-Play)
          </label>
          <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.16)]">
            {(['BR_RANK', 'CS_RANK'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setGameMode(m)}
                className={`h-9 rounded-lg text-[11px] font-extrabold transition-colors cursor-pointer ${
                  gameMode === m
                    ? 'bg-[#ef4444] text-[#f7f5f0]'
                    : 'text-[#a8a29e] hover:text-[#f7f5f0]'
                }`}
              >
                {GAME_MODE_LABELS[m]}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3.5">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[10.5px] font-bold uppercase tracking-[1px] text-[#a8a29e]">
                Bot Name Prefix
              </label>
              <span className="text-[10.5px] font-mono-num text-[#14b8a6]">
                {cleanPrefix}•XXXXX
              </span>
            </div>
            <input
              type="text"
              maxLength={6}
              value={botPrefix}
              onChange={(e) => setBotPrefix(e.target.value.replace(/[^\w-]/g, '').slice(0, 6))}
              placeholder="RDX"
              className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.16)] font-mono-num text-sm outline-none focus:border-[#ef4444]"
            />
          </div>
          <div className="flex flex-col justify-end">
            <span className="block text-[10.5px] font-bold uppercase tracking-[1px] text-[#a8a29e] mb-1.5">
              Match Start
            </span>
            <div className="flex h-11 items-center rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-3.5 text-sm font-bold text-emerald-400">
              Immediate when squad is ready
            </div>
          </div>
        </div>

        {/* LIVE ASSIGNMENT PREVIEW */}
        <div className="mb-4 px-3.5 py-2.5 rounded-xl bg-emerald-500/8 border border-emerald-500/25 text-xs text-emerald-300 flex items-center gap-2">
          <Users size={14} className="shrink-0 text-emerald-400" />
          <span className="font-semibold leading-snug">{splitPreview}</span>
        </div>

        <div className="flex justify-end gap-2.5 mt-4">
          <button
            type="button"
            onClick={onClose}
            className="h-10 px-4 rounded-xl bg-[#1e1515] border border-[rgba(239,68,68,0.16)] text-[13px] font-bold hover:border-[rgba(239,68,68,0.38)] cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading || !/^\d+$/.test(effectiveClanId)}
            className="h-10 px-4 rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-400 text-[#080000] text-[13px] font-bold inline-flex items-center gap-2 cursor-pointer disabled:opacity-60"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Bolt size={14} />}
            Create &amp; Start
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

interface ConfirmModalProps {
  open: boolean;
  title?: string;
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmModal({ open, title = 'Confirm', message, onCancel, onConfirm }: ConfirmModalProps) {
  return (
    <ModalShell open={open} onClose={onCancel} title={title}>
      <p className="text-[#a8a29e] text-[13px] mb-5 leading-relaxed">{message}</p>
      <div className="flex justify-end gap-2.5">
        <button
          type="button"
          onClick={onCancel}
          className="h-10 px-4 rounded-xl bg-[#1e1515] border border-[rgba(239,68,68,0.16)] text-[13px] font-bold cursor-pointer"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="h-10 px-4 rounded-xl bg-red-500/15 border border-red-500/40 text-red-400 text-[13px] font-bold inline-flex items-center gap-2 hover:bg-red-500/25 cursor-pointer"
        >
          <Trash2 size={14} />
          Confirm
        </button>
      </div>
    </ModalShell>
  );
}

interface EngineModalProps {
  open: boolean;
  onClose: () => void;
  apiBase: string;
  onSaveApiBase: (nextBase: string) => void;
}

export function EngineModal({ open, onClose, apiBase, onSaveApiBase }: EngineModalProps) {
  const [urlInput, setUrlInput] = useState(apiBase);

  useEffect(() => {
    if (open) setUrlInput(apiBase);
  }, [open, apiBase]);

  return (
    <ModalShell open={open} onClose={onClose} title="Engine Endpoint">
      <p className="text-[#a8a29e] text-[13px] mb-4 leading-relaxed">
        The built-in Node engine runs live on this server by default (leave URL blank), or point to an external RDX engine endpoint.
      </p>

      <div className="mb-4">
        <label className="block text-[10.5px] font-bold uppercase tracking-[1px] text-[#a8a29e] mb-1.5">
          External Engine URL (Optional — Blank = Built-in Live Server)
        </label>
        <input
          type="url"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder="Leave blank for built-in live server"
          className="w-full h-11 px-3.5 rounded-xl bg-[#0f0000] border border-[rgba(239,68,68,0.16)] font-mono-num text-xs outline-none focus:border-[#ef4444]"
        />
      </div>

      <div className="flex flex-wrap justify-end gap-2.5">
        <button
          type="button"
          onClick={() => {
            setUrlInput('');
            onSaveApiBase('');
            onClose();
          }}
          className="h-10 px-3.5 rounded-xl bg-[#1e1515] border border-emerald-500/35 text-emerald-400 text-[13px] font-bold cursor-pointer mr-auto"
        >
          Use Live Server
        </button>
        <button
          type="button"
          onClick={onClose}
          className="h-10 px-4 rounded-xl bg-[#1e1515] border border-[rgba(239,68,68,0.16)] text-[13px] font-bold cursor-pointer"
        >
          Close
        </button>
        <button
          type="button"
          onClick={() => {
            onSaveApiBase(urlInput.trim().replace(/\/+$/, ''));
            onClose();
          }}
          className="h-10 px-4 rounded-xl bg-gradient-to-br from-[#ef4444] to-[#dc2626] text-[#f7f5f0] text-[13px] font-bold cursor-pointer"
        >
          Save Endpoint
        </button>
      </div>
    </ModalShell>
  );
}
