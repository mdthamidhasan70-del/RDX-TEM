import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { CLAN_ID_DEFAULT, engine } from './server/engine.ts';

const PORT = Number.isFinite(Number(process.env.PORT)) ? Number(process.env.PORT) : 3000;
const HOST = process.env.HOST || '0.0.0.0';
const IS_PROD = process.env.NODE_ENV === 'production';

const parseNumber = (value: unknown, fallback = 0): number => {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const asyncRoute =
  (handler: (req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler =>
  (req, res, next) => {
    void handler(req, res).catch(next);
  };

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (_req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/api/ping', (_req, res) => {
    res.json({ pong: true, app: 'RDX TEM', version: '2.0', runtime: 'node-live' });
  });

  app.get('/api/stats', (_req, res) => {
    res.json(engine.getStatsPayload());
  });

  app.get('/api/state', (_req, res) => {
    const payload = engine.getStatsPayload();
    res.json({
      creating: payload.creating,
      create_progress: payload.create_progress,
      accounts: payload.accounts,
      team_size: payload.team_size,
    });
  });

  app.get('/api/progress', (_req, res) => {
    res.json({
      creating: engine.creating,
      create_progress: engine.createProgress.slice(-60),
    });
  });

  app.get('/api/clan/lookup', asyncRoute(async (req, res) => {
    const clanId = String(req.query?.clan_id || '').trim();
    if (!clanId || !/^\d+$/.test(clanId)) {
      res.json({ ok: false, found: false, clan_id: clanId });
      return;
    }
    const result = await engine.lookupClanReal(clanId);
    res.json({ ok: true, ...result });
  }));

  app.post('/api/guild/create', asyncRoute(async (req, res) => {
    const clanId = String(req.body?.clan_id || '').trim();
    if (!clanId || !/^\d+$/.test(clanId)) {
      res.json({ ok: false, error: 'Valid numeric Guild UID is required' });
      return;
    }
    const guild = await engine.createGuild({
      clan_id: clanId,
      name: typeof req.body?.name === 'string' ? req.body.name : undefined,
      days: parseNumber(req.body?.days, 0),
      hours: parseNumber(req.body?.hours, 0),
      minutes: parseNumber(req.body?.minutes, 0),
    });
    res.json({ ok: true, guild });
  }));

  app.post('/api/guild/update', (req, res) => {
    const clanId = String(req.body?.clan_id || '').trim();
    if (!clanId) {
      res.json({ ok: false, error: 'clan_id required' });
      return;
    }
    const guild = engine.updateGuild({
      clan_id: clanId,
      name: typeof req.body?.name === 'string' ? req.body.name : undefined,
      days: req.body?.days !== undefined ? parseNumber(req.body.days, 0) : undefined,
      hours: req.body?.hours !== undefined ? parseNumber(req.body.hours, 0) : undefined,
      minutes: req.body?.minutes !== undefined ? parseNumber(req.body.minutes, 0) : undefined,
      is_paused: typeof req.body?.is_paused === 'boolean' ? req.body.is_paused : undefined,
    });
    if (!guild) {
      res.json({ ok: false, error: 'Guild not found' });
      return;
    }
    res.json({ ok: true, guild });
  });

  app.post('/api/guild/delete', (req, res) => {
    const clanId = String(req.body?.clan_id || '').trim();
    const deleteAccounts = req.body?.delete_accounts !== false;
    if (!clanId) {
      res.json({ ok: false, error: 'clan_id required' });
      return;
    }
    engine.deleteGuild(clanId, deleteAccounts);
    res.json({ ok: true });
  });

  app.post('/api/squad/create', asyncRoute(async (req, res) => {
    const result = await engine.createSquad({
      clan_id: String(req.body?.clan_id || '').trim(),
      target_squad_id: typeof req.body?.target_squad_id === 'string' ? req.body.target_squad_id : undefined,
      name: typeof req.body?.name === 'string' ? req.body.name : undefined,
      target_size: req.body?.target_size !== undefined ? parseNumber(req.body.target_size, 4) : undefined,
      game_mode: typeof req.body?.game_mode === 'string' ? req.body.game_mode : undefined,
      lobby_delay_sec: req.body?.lobby_delay_sec !== undefined ? parseNumber(req.body.lobby_delay_sec, 0) : undefined,
      bot_prefix: typeof req.body?.bot_prefix === 'string' ? req.body.bot_prefix : undefined,
      mode: req.body?.mode === 'assign_existing' ? 'assign_existing' : 'create_bots',
      count: req.body?.count !== undefined ? parseNumber(req.body.count, 4) : undefined,
      password: typeof req.body?.password === 'string' ? req.body.password : undefined,
      account_uids: Array.isArray(req.body?.account_uids) ? req.body.account_uids.map(String) : undefined,
    });
    res.json(result);
  }));

  app.post('/api/squad/update', (req, res) => {
    const squadId = String(req.body?.squad_id || '').trim();
    if (!squadId) {
      res.json({ ok: false, error: 'squad_id required' });
      return;
    }
    const squad = engine.updateSquad({
      squad_id: squadId,
      name: typeof req.body?.name === 'string' ? req.body.name : undefined,
      target_size: req.body?.target_size !== undefined ? parseNumber(req.body.target_size, 4) : undefined,
      game_mode: typeof req.body?.game_mode === 'string' ? req.body.game_mode : undefined,
      lobby_delay_sec: req.body?.lobby_delay_sec !== undefined ? parseNumber(req.body.lobby_delay_sec, 0) : undefined,
      bot_prefix: typeof req.body?.bot_prefix === 'string' ? req.body.bot_prefix : undefined,
      clan_id: typeof req.body?.clan_id === 'string' ? req.body.clan_id : undefined,
      is_paused: typeof req.body?.is_paused === 'boolean' ? req.body.is_paused : undefined,
      add_uids: Array.isArray(req.body?.add_uids) ? req.body.add_uids.map(String) : undefined,
      remove_uids: Array.isArray(req.body?.remove_uids) ? req.body.remove_uids.map(String) : undefined,
    });
    if (!squad) {
      res.json({ ok: false, error: 'Squad not found' });
      return;
    }
    res.json({ ok: true, squad });
  });

  app.post('/api/squad/restart', (req, res) => {
    const squadId = String(req.body?.squad_id || '').trim();
    const ok = engine.restartSquad(squadId);
    res.json({ ok });
  });

  app.post('/api/squad/delete', (req, res) => {
    const squadId = String(req.body?.squad_id || '').trim();
    const deleteAccounts = Boolean(req.body?.delete_accounts);
    if (!squadId) {
      res.json({ ok: false, error: 'squad_id required' });
      return;
    }
    engine.deleteSquad(squadId, deleteAccounts);
    res.json({ ok: true });
  });

  app.post('/api/create_team', asyncRoute(async (req, res) => {
    const clanId = String(req.body?.clan_id || '').trim();
    const rawSquadId = typeof req.body?.squad_id === 'string' ? req.body.squad_id.trim() : '';
    const squadId = rawSquadId && rawSquadId !== '__new__' ? rawSquadId : undefined;
    const squadName = typeof req.body?.squad_name === 'string' ? req.body.squad_name.trim() || undefined : undefined;
    const gameMode = typeof req.body?.game_mode === 'string' ? req.body.game_mode : undefined;
    const lobbyDelaySec = req.body?.lobby_delay_sec !== undefined ? parseNumber(req.body.lobby_delay_sec, 0) : undefined;
    const botPrefix = typeof req.body?.bot_prefix === 'string' ? req.body.bot_prefix : undefined;
    const minCount = squadId ? 1 : 2;
    const count = Math.max(minCount, Math.min(12, Number.isFinite(parseNumber(req.body?.count, 4)) ? parseNumber(req.body?.count, 4) : 4));
    const password = String(req.body?.password || 'RDX771').trim() || 'RDX771';

    if (!clanId || !/^\d+$/.test(clanId)) {
      res.json({ ok: false, error: 'Valid numeric Guild UID is required' });
      return;
    }

    const result = await engine.createTeamBots(clanId, count, password, {
      squadId,
      squadName,
      gameMode,
      lobbyDelaySec,
      botPrefix,
    });
    res.json({
      ok: result.ok,
      error: result.error,
      squads: result.squads,
      msg: result.ok ? `creating ${count} bots` : result.error,
    });
  }));

  app.post('/api/account/add', asyncRoute(async (req, res) => {
    const clanId = String(req.body?.clan_id || '').trim() || CLAN_ID_DEFAULT;
    const rawSquadId = typeof req.body?.squad_id === 'string' ? req.body.squad_id.trim() : '';
    const squadName = typeof req.body?.squad_name === 'string' ? req.body.squad_name.trim() || undefined : undefined;
    const botPrefix = typeof req.body?.bot_prefix === 'string' ? req.body.bot_prefix.trim() || undefined : undefined;
    const token = String(req.body?.token || '').trim();
    if (token) {
      const resolvedSquadId = await engine.ensureSquadForAdd(clanId, rawSquadId, squadName);
      void engine.addTokenAccount(token, clanId, resolvedSquadId);
      res.json({ status: 'ok', clan_id: clanId, squad_id: resolvedSquadId });
      return;
    }

    const uid = String(req.body?.uid || '').trim();
    const password = String(req.body?.password || '').trim();
    if (!uid || !password) {
      res.json({ status: 'error', error: 'uid/password required' });
      return;
    }

    const resolvedSquadId = await engine.ensureSquadForAdd(clanId, rawSquadId, squadName);
    const db = engine.loadAccountsDb().filter((a) => String(a.uid) !== uid);
    const row = {
      uid,
      password,
      region: 'BD',
      clan_id: clanId,
      squad_id: resolvedSquadId,
      ...(botPrefix ? { bot_prefix: botPrefix } : {}),
    };
    db.push(row);
    engine.saveAccountsDb(db);
    engine.startGuestWorker(row);
    res.json({ status: 'ok', clan_id: clanId, squad_id: resolvedSquadId });
  }));

  app.post('/api/account/delete', (req, res) => {
    const uid = String(req.body?.uid || '').trim();
    const authUid = String(req.body?.auth_uid || '').trim();
    engine.deleteAccount(uid, authUid);
    res.json({ status: 'ok' });
  });

  app.post('/api/accounts/clear_all', (_req, res) => {
    const removed = engine.clearAllAccounts();
    res.json({ ok: true, status: 'ok', removed });
  });

  app.post('/api/workspace/sync', (req, res) => {
    const summary = engine.syncWorkspaceFromCloud({
      guilds: Array.isArray(req.body?.guilds) ? req.body.guilds : undefined,
      squads: Array.isArray(req.body?.squads) ? req.body.squads : undefined,
      accounts: Array.isArray(req.body?.accounts) ? req.body.accounts : undefined,
    });
    res.json({ ok: true, ...summary });
  });

  app.post('/api/account/refresh', (req, res) => {
    const uid = String(req.body?.uid || '').trim();
    void engine.refreshAccountProfile(uid);
    res.json({ status: 'ok' });
  });

  app.post('/api/account/restart', (req, res) => {
    const uid = String(req.body?.uid || '').trim();
    const restarted = engine.restartAccount(uid);
    res.json({ status: 'ok', restarted });
  });

  app.post('/api/account/pause', (req, res) => {
    const uid = String(req.body?.uid || '').trim();
    const nextPaused = !engine.isPaused(uid);
    engine.togglePause(uid, nextPaused);
    res.json({ status: 'ok', is_paused: nextPaused });
  });

  app.post('/api/account/pause_all', (_req, res) => {
    const keys = Array.from(engine.accounts.keys());
    if (keys.length === 0) {
      res.json({ status: 'ok', all_paused: false });
      return;
    }
    const allPaused = keys.every((u) => engine.isPaused(u));
    const nextState = !allPaused;
    for (const u of keys) {
      engine.togglePause(u, nextState);
    }
    res.json({ status: 'ok', all_paused: nextState });
  });

  app.post('/api/logs/clear', (_req, res) => {
    engine.logs = [];
    res.json({ status: 'ok' });
  });

  if (!IS_PROD) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found');
      }
    });
  }

  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.path.startsWith('/api/')) {
      const msg = err instanceof Error ? err.message : 'Internal server error';
      res.status(500).json({ ok: false, status: 'error', error: msg });
      return;
    }
    next(err);
  });

  app.listen(PORT, HOST, () => {
    console.log(`RDX TEM Command Center & Live Engine listening on http://${HOST}:${PORT}`);
    if (process.env.RDX_DISABLE_ENGINE_BOOT === '1') {
      console.log('Engine worker boot skipped (RDX_DISABLE_ENGINE_BOOT=1)');
    } else {
      void engine.boot();
    }
  });
}

void startServer();
