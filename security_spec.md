# Security Specification — RDX TEM Command Center

## 1. Roles & Trust Boundaries
- **Owner (`user`)**: Authenticated user (`request.auth != null && request.auth.token.email_verified == true`). Can read/write strictly within `/users/{request.auth.uid}/...`.
- **Unauthenticated / Cross-tenant**: Denied everywhere by default (`allow read, write: if false`). No public listing or cross-user access exists.

## 2. Collection Hierarchy & Data Invariants
- `/users/{userId}`
  - Only `userId == request.auth.uid`.
  - Required fields: `uid`, `email`, `displayName`, `createdAt`, `updatedAt`.
  - `uid == userId`, `createdAt == request.time` on create (immutable thereafter), `updatedAt == request.time`.
- `/users/{userId}/guilds/{guildId}`
  - Owner-isolated under `/users/{userId}`.
  - `clan_id == guildId`, numeric digits `1..24`, `name` `1..80` chars, `region` `2..12` chars.
  - Timer bounds: `duration_days` `[0, 365]`, `duration_hours` `[0, 23]`, `duration_minutes` `[0, 59]`, `expires_at` null or finite number.
  - `ownerUid == userId` (immutable). `createdAt` immutable, `updatedAt == request.time`.
- `/users/{userId}/squads/{squadId}`
  - Owner-isolated under `/users/{userId}`.
  - `id == squadId`, `target_size` in `[2, 4]`, `game_mode` strictly in `['BR', 'BR_RANK', 'CS', 'CS_RANK']`.
  - `lobby_delay_sec` in `[0, 120]`, `bot_prefix` `1..8` chars, `name` `1..64` chars.
  - `ownerUid == userId` (immutable). `createdAt` immutable, `updatedAt == request.time`.
- `/users/{userId}/accounts/{accountId}`
  - Owner-isolated under `/users/{userId}`.
  - `uid == accountId`, non-empty `password` `1..64` chars, `bot_prefix` `0..8` chars, `nickname` `0..40` chars, `max_matches` `[0, 100000]`, `max_hours` `[0, 8760]`.
  - `ownerUid == userId` (immutable). `createdAt` immutable, `updatedAt == request.time`.

## 3. Dirty Dozen Attack Vectors Blocked
1. **Cross-tenant read/write**: Path `{userId}` must match `request.auth.uid` AND `ownerUid == request.auth.uid`.
2. **Unverified / spoofed auth**: Enforces `request.auth != null && request.auth.token.email_verified == true`.
3. **Wildcard schema injection**: Every collection validates `keys().hasAll(...) && keys().hasOnly(...)`.
4. **Update action smuggling**: Update rules enforce `diff(resource.data).affectedKeys().hasOnly(...)` allowing only mutable operational fields.
5. **Ownership hijacking on update**: `ownerUid` and `createdAt` are explicitly locked to `resource.data` values.
6. **Timestamp spoofing**: `createdAt == request.time` on create; `updatedAt == request.time` on create and update.
7. **Invalid enum / mode spoofing**: `game_mode` restricted strictly to `['BR', 'BR_RANK', 'CS', 'CS_RANK']`.
8. **Out-of-range squad sizes or delays**: `target_size` clamped `[2, 4]`; `lobby_delay_sec` clamped `[0, 120]`.
9. **Path traversal / malformed document IDs**: `isValidId()` rejects `.`, `..`, `/`, and enforces `[A-Za-z0-9_-]{1,64}`.
10. **Oversized payloads**: Strict string length bounds (`<= 80` chars) on every text field.
11. **Type confusion**: Explicit `is string`, `is bool`, `is number`, `is timestamp` checks on every field.
12. **Fallback exposure**: Terminal catch-all `match /{document=**} { allow read, write: if false; }` locks down any unlisted path.
