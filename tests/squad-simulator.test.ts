import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampInteger,
  engine,
  getMatchStartModeId,
  getMatchmakingRetryDelayMs,
  getNextMatchCountdownSeconds,
  getNextModeProfileIndex,
  getSquadProvisioningStatus,
  isCleanUdpMatchFinish,
  extractTeamIdentity,
  isMatchmakingRetryAllowed,
  isConfirmedSquadMember,
  isSameSquadInvite,
  resolveSquadLeaderUid,
  sanitizeFiniteNumber,
  shouldResetSquadMatchCycle,
} from '../server/engine.ts';
import { formatStatusText } from '../src/types.ts';

test('resolveSquadLeaderUid prefers the fixed slot-1 member when present', () => {
  assert.equal(resolveSquadLeaderUid(['u2', 'u1', 'u3'], 'u1'), 'u1');
  assert.equal(resolveSquadLeaderUid(['u2', 'u3'], 'u9'), 'u2');
});

test('accept same-squad invite when current group id is still unset', () => {
  const squadPeers = new Set(['u1', 'u2', 'u3']);
  assert.equal(isSameSquadInvite('u2', null, null, squadPeers, 'u1'), true);
});

test('reject mismatched group or foreign squad invite', () => {
  const squadPeers = new Set(['u1', 'u2', 'u3']);
  assert.equal(isSameSquadInvite('u9', 'group-a', 'group-b', squadPeers, 'u1'), false);
  assert.equal(isSameSquadInvite('u9', 'group-a', null, squadPeers, 'u1'), false);
});

test('confirms membership only when roster contains the player in the expected group', () => {
  const roster = new Set(['u1', 'u2', 'u3']);
  assert.equal(isConfirmedSquadMember('u2', roster, 'group-a', 'group-a'), true);
  assert.equal(isConfirmedSquadMember('u4', roster, 'group-a', 'group-a'), false);
  assert.equal(isConfirmedSquadMember('u2', roster, 'group-b', 'group-a'), false);
  assert.equal(isConfirmedSquadMember('u2', roster, null, 'group-a'), false);
});

test('handles empty or missing squad state without crashing', () => {
  assert.equal(resolveSquadLeaderUid(null, 'u1'), null);
  assert.equal(resolveSquadLeaderUid(['', '  ', 'u2'], 'u9'), 'u2');
  assert.equal(isSameSquadInvite('u9', 'group-a', 'group-a', null, 'u1'), false);
  assert.equal(isSameSquadInvite('u1', null, 'group-a', null, 'u1'), true);
  assert.equal(isConfirmedSquadMember('u2', null, 'group-a', 'group-a'), false);
  assert.equal(isConfirmedSquadMember('u2', ['u1', 'u2'], 'group-a', 'group-a'), true);
});

test('guild-only rows are not treated as active squad members', () => {
  const runtime = engine as any;
  assert.equal(runtime.getSquadKey('123456', null), 'guild_123456');
  assert.equal(runtime.isSquadActive('guild_123456'), false);
  assert.equal(runtime.isSquadActive('default_squad'), false);
});

test('status updates preserve active squad membership when reconnecting or re-online', () => {
  engine.registerAccount('1001', 'Alpha', 'BD', 1, 0, 0, 'auth-1', { clan_id: '9001', squad_id: 'sq_1' });
  engine.updateStatus('1001', 'SQUAD JOINED', 0);
  assert.equal(engine.accounts.get('1001')?.in_squad, true);
  assert.equal(engine.accounts.get('1001')?.guild_joined, true);

  engine.updateStatus('1001', 'ONLINE', 0);
  assert.equal(engine.accounts.get('1001')?.in_squad, true);
  assert.equal(engine.accounts.get('1001')?.guild_joined, true);

  engine.updateStatus('1001', 'OFFLINE', 0);
  assert.equal(engine.accounts.get('1001')?.in_squad, false);
  assert.equal(engine.accounts.get('1001')?.guild_joined, false);
});

test('invalid numeric inputs are sanitized instead of producing NaN values', () => {
  assert.equal(sanitizeFiniteNumber('abc', 7), 7);
  assert.equal(sanitizeFiniteNumber('5', 2), 5);
  assert.equal(clampInteger(Number.NaN, 4, 2, 12), 4);
  assert.equal(clampInteger(20, 4, 2, 12), 12);
  assert.equal(clampInteger(-3, 4, 2, 12), 2);
});

test('resets the squad match cycle only after the configured completion threshold', () => {
  assert.equal(shouldResetSquadMatchCycle(9), false);
  assert.equal(shouldResetSquadMatchCycle(10), true);
  assert.equal(shouldResetSquadMatchCycle('invalid'), false);
});

test('advances to the next ranked queue profile and wraps after the last profile', () => {
  assert.equal(getNextModeProfileIndex(2), 3);
  assert.equal(getNextModeProfileIndex(3), 0);
});

test('uses the selected ranked mode in the match-start packet', () => {
  assert.equal(getMatchStartModeId('CS_RANK'), 15);
  assert.equal(getMatchStartModeId('BR_RANK'), 2);
});

test('blocks repeated matchmaking requests until the rejection backoff expires', () => {
  assert.equal(isMatchmakingRetryAllowed(10_000, 9_999), false);
  assert.equal(isMatchmakingRetryAllowed(10_000, 10_000), true);
  assert.equal(isMatchmakingRetryAllowed(0, 9_999), true);
});

test('counts down to the next match without going below zero', () => {
  assert.equal(getNextMatchCountdownSeconds(105_000, 100_000), 5);
  assert.equal(getNextMatchCountdownSeconds(100_001, 100_000), 1);
  assert.equal(getNextMatchCountdownSeconds(100_000, 100_000), 0);
  assert.equal(getNextMatchCountdownSeconds('invalid', 100_000), 0);
});

test('uses fast retry only for explicit cancellation, not generic server rejection', () => {
  assert.equal(getMatchmakingRetryDelayMs('match cancelled by server'), 500);
  assert.equal(getMatchmakingRetryDelayMs('19156542264 | 3 | 10 | G'), 30_000);
});

test('counts only clean UDP match finishes as completed matches', () => {
  assert.equal(isCleanUdpMatchFinish('completed'), true);
  assert.equal(isCleanUdpMatchFinish('interrupted'), false);
  assert.equal(isCleanUdpMatchFinish('expired'), false);
  assert.equal(isCleanUdpMatchFinish('MATCH_COMPLETE'), false);
});

test('extracts team code and group identity from broad roster responses', () => {
  const identity = extractTeamIdentity(
    { 1: '1234567', 5: { 14: 'A1B2C3D4E5F678901234567890' } } as any,
    ['A1B2C3D4E5F678901234567890'],
    [19181059892],
  );
  assert.equal(identity.teamCode, '1234567');
  assert.equal(identity.groupId, 'A1B2C3D4E5F678901234567890');
});

test('marks unfilled squads as needing players unless account creation is pending', () => {
  assert.equal(getSquadProvisioningStatus(0, 4, 0), 'NEEDS PLAYERS');
  assert.equal(getSquadProvisioningStatus(2, 4, 2), 'SQUAD CREATING');
  assert.equal(getSquadProvisioningStatus(4, 4, 0), null);
});

test('shows sent matchmaking requests as unconfirmed', () => {
  assert.equal(formatStatusText('SEARCHING', 'CS_RANK'), 'CS Rank request unconfirmed');
  assert.equal(formatStatusText('MATCHING', 'BR_RANK'), 'BR Rank request unconfirmed');
});

