# RDX TEM Command Center — Project Handoff

This document describes the local application structure and its supported workflows for an authorized developer. It contains no account credentials, access tokens, private keys, or live-service packet specifications. Do not copy private files or secrets into a public sharing service.

## 1. Project summary

RDX TEM is a browser-based command center with a React/TypeScript frontend and a Node.js/Express backend. It presents account, guild, squad, match, and activity state and coordinates the local engine workers. The frontend is served by Vite during development and from `dist/` in production.

The app's match panel reports the selected ranked mode and live state. After a completed match, a squad waits in the lobby for five seconds with a visible countdown, then starts the next queue while retaining its group. After ten completed matches, the squad cycle resets and the leader creates a fresh group.

For local dashboard/API checks without automatically starting account workers, run `$env:RDX_DISABLE_ENGINE_BOOT='1'; npm run dev` in PowerShell. This only skips automatic engine boot; API actions that create or restart workers can still start them.

## 2. Main project structure

```text
.
├── server.ts                     # Express entry point and local HTTP API
├── server/
│   ├── engine.ts                 # Runtime state, account workers, guild/squad orchestration
│   ├── proto.ts                  # Private service-integration implementation
│   └── udp.ts                    # Match-session lifecycle handling
├── src/
│   ├── main.tsx                  # React application entry point
│   ├── App.tsx                   # Authentication shell, navigation, stats polling
│   ├── firebase.ts               # Firebase client setup; configure privately
│   ├── types.ts                  # Shared frontend types and display helpers
│   ├── index.css                 # Global styles
│   └── components/
│       ├── LoginEntry.tsx        # Sign-in view
│       ├── MySquadView.tsx       # Guild, squad, match-flow, and player UI
│       ├── Modals.tsx            # Create/edit forms and confirmations
│       └── RdxBackground.tsx     # Shared background presentation
├── tests/
│   └── squad-simulator.test.ts   # Focused squad and match-cycle tests
├── public/                       # Static assets
├── data/                          # Local runtime state; contains private account data
├── package.json                  # Scripts and dependencies
└── vite.config.ts                # Vite configuration
```

## 3. Application architecture

### Frontend

- `App.tsx` owns the authenticated application shell, page navigation, API calls, polling, and notifications.
- `MySquadView.tsx` displays guild and squad management, member profiles, team code, server region/mode configuration, and the five-step ranked-match workflow.
- `types.ts` defines the account, guild, squad, and statistics shapes plus status formatting.
- The frontend polls live statistics and renders backend-confirmed state; it should not invent group membership or match completion.

### Backend

- `server.ts` starts Express, installs JSON and CORS middleware, exposes the local API, and attaches Vite in development or `dist/` in production.
- `server/engine.ts` owns persistent configuration, runtime maps, account workers, group coordination, status transitions, queue retries, and the ten-match reset counter.
- `server/udp.ts` owns the live match-session lifecycle and reports session start, interruption, expiry, and completion to the engine.
- `server/proto.ts` contains private integration details. Keep it access-controlled and use only service integrations the project owner is authorized to operate.

### Runtime state

The engine maintains in-memory account and squad runtime state. Persistent configuration is stored under `data/`, including account rows, guilds, squads, cached authentication material, and match-resume state. Treat the entire directory as sensitive. Do not commit it, upload it, or include it in handoff archives.

## 4. High-level workflow

1. A user signs in through the configured Firebase client.
2. The frontend loads the local API statistics and renders the command center.
3. A guild and squad configuration determine the roster, selected ranked mode, and leader slot. Squads with fewer assigned accounts than their target show `NEEDS PLAYERS`; while account creation is pending they show `SQUAD CREATING`, and neither state is match-ready.
4. The engine reports guild join, server-confirmed squad membership, matchmaking requests, in-match, and completed-match states. Locally sent `SEARCHING` / `MATCHING` requests are labeled unconfirmed and do not complete the Ranked Search step; a sent request is not proof of a match. The UI marks Match Start green only after server-confirmed match recovery/in-game state, and cancellations or rejections red with retry pending. The ranked flow shows the selected mode and fixed team leader. Explicit cancellation retries quickly; generic short/rejected responses remain together and back off for 30 seconds to avoid repeatedly sending a request the service is rejecting.
5. After a match completes, the engine keeps the squad together for a five-second lobby wait, then starts the next search. The countdown is exposed as `next_match_at` / `next_match_in_sec` and shown on each player's squad card. The completed-match cycle persists; after ten matches the squad is reset after the lobby wait.
6. The existing group is kept for the next queue. At ten completed matches the counter resets, workers reconnect, and a fresh leader-created group is formed.

The UI only marks the group step complete when the backend has a real team code, group ID, and confirmed roster.

## 5. Local HTTP API inventory

These are application-local routes exposed by `server.ts`. This inventory describes their purpose, not credentials or live-service request formats.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/ping` | Local process health |
| GET | `/api/stats` | Full dashboard snapshot |
| GET | `/api/state` | Compact account/creation state |
| GET | `/api/progress` | Recent creation progress |
| GET | `/api/clan/lookup` | Guild lookup by numeric ID |
| POST | `/api/guild/create` | Save a guild configuration |
| POST | `/api/guild/update` | Update a guild configuration |
| POST | `/api/guild/delete` | Delete a guild and optionally its accounts |
| POST | `/api/squad/create` | Create or populate a squad |
| POST | `/api/squad/update` | Update squad settings or roster |
| POST | `/api/squad/restart` | Restart squad workers and grouping |
| POST | `/api/squad/delete` | Delete a squad and optionally its accounts |
| POST | `/api/create_team` | Queue account creation for one or more squads |
| POST | `/api/account/add` | Add an account to the local workspace |
| POST | `/api/account/delete` | Remove an account |
| POST | `/api/accounts/clear_all` | Clear all local account rows |
| POST | `/api/account/refresh` | Refresh displayed account profile data |
| POST | `/api/account/restart` | Restart one account worker |
| POST | `/api/account/pause` | Toggle one account's paused state |
| POST | `/api/account/pause_all` | Toggle all account workers |
| POST | `/api/workspace/sync` | Restore workspace configuration from the configured sync source |
| POST | `/api/logs/clear` | Clear in-memory engine logs |

These routes are intended for the local application. Before exposing the service to a network, add appropriate authentication, authorization, origin restrictions, and request protections.

## 6. Development and verification

Requirements: a Node.js release compatible with the installed Vite 8 toolchain and npm.

```powershell
npm install
npm run dev
npm run lint
node --test tests/squad-simulator.test.ts
npm run build
```

The development server defaults to port `3000`. Set `PORT` or `HOST` only in the local environment when needed. Never put secrets in source files or documentation.

## 7. Handoff and maintenance notes

- Configure Firebase only with the project owner's authorized development settings.
- Keep account files, token caches, match-resume data, and `.env` files private and out of version control.
- The frontend should consume engine statistics rather than infer server-side state.
- Add regression tests when changing squad lifecycle transitions, countdown timing, or the ten-match reset behavior.
- Private third-party service endpoints, authentication formats, and packet construction are intentionally not reproduced in this handoff. Use official, authorized integration documentation for those details.
