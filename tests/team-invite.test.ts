import assert from 'node:assert/strict';
import test from 'node:test';

import {
  engine,
  getReconnectDelayMs,
  getSquadAvailableSlots,
  getEffectiveSquadSize,
  isConfirmedSquadMember,
  isSameSquadInvite,
  resolveSquadLeaderUid,
} from '../server/engine.ts';

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

test('reconnect backoff grows gradually and remains bounded', () => {
  assert.equal(getReconnectDelayMs(1), 5_000);
  assert.equal(getReconnectDelayMs(3), 20_000);
  assert.equal(getReconnectDelayMs(20), 5 * 60_000);
});

test('squad capacity includes pending player creation and never exceeds four', () => {
  assert.equal(getSquadAvailableSlots(0), 4);
  assert.equal(getSquadAvailableSlots(2, 1), 1);
  assert.equal(getSquadAvailableSlots(4), 0);
  assert.equal(getSquadAvailableSlots(3, 2), 0);
});

test('partial 2 and 3 player squads use their actual effective roster', () => {
  assert.equal(getEffectiveSquadSize(4, 2, 0), 2);
  assert.equal(getEffectiveSquadSize(4, 3, 0), 3);
  assert.equal(getEffectiveSquadSize(4, 4, 0), 4);
  assert.equal(getEffectiveSquadSize(4, 3, 1), 4);
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
  assert.equal(engine.accounts.get('1001')?.in_squad, true);
  assert.equal(engine.accounts.get('1001')?.guild_joined, true);
});
