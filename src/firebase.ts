import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getFirestore,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';
import { normalizeGameMode, type GuildInfo, type SavedAccountRow, type SquadInfo } from './types';

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null,
): void {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData.map((provider) => ({
          providerId: provider.providerId,
          displayName: provider.displayName,
          email: provider.email,
          photoUrl: provider.photoURL,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
}

let connectionTested = false;
export async function testConnection(): Promise<void> {
  if (connectionTested) return;
  connectionTested = true;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration (client offline).');
    }
  }
}

export function canUseCloudSync(userId?: string): boolean {
  const cur = auth.currentUser;
  if (!cur || !cur.emailVerified) return false;
  if (userId && cur.uid !== userId) return false;
  return true;
}

const docWriteChains = new Map<string, Promise<void>>();
const ensuredProfileCache = new Map<string, string>();

function enqueueDocWrite(path: string, task: () => Promise<void>): Promise<void> {
  const prev = docWriteChains.get(path) || Promise.resolve();
  const next = prev.catch(() => undefined).then(task);
  docWriteChains.set(path, next);
  return next.finally(() => {
    if (docWriteChains.get(path) === next) {
      docWriteChains.delete(path);
    }
  });
}

function sanitizeDocId(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 64);
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function normalizePrefix(val: unknown): string {
  const clean = String(val || 'RDX')
    .replace(/[^\w-]/g, '')
    .slice(0, 8);
  return clean || 'RDX';
}

export interface CloudWorkspace {
  guilds: Partial<GuildInfo>[];
  squads: Partial<SquadInfo>[];
  accounts: SavedAccountRow[];
}

export async function ensureUserProfileDoc(
  userId: string,
  email: string,
  displayName?: string | null,
): Promise<void> {
  if (!canUseCloudSync(userId)) return;
  const uid = sanitizeDocId(userId);
  if (!uid) return;
  const rawEmail = String(email || auth.currentUser?.email || 'user@rdx.local').trim();
  const safeEmail = (rawEmail.length >= 3 ? rawEmail : 'user@rdx.local').slice(0, 160);
  const safeName = String(
    displayName || auth.currentUser?.displayName || safeEmail.split('@')[0] || 'Operator',
  ).slice(0, 120);
  const cacheSig = `${safeEmail}|${safeName}`;
  if (ensuredProfileCache.get(uid) === cacheSig) return;

  const path = `users/${uid}`;
  await enqueueDocWrite(path, async () => {
    if (!canUseCloudSync(userId)) return;
    if (ensuredProfileCache.get(uid) === cacheSig) return;
    const ref = doc(db, 'users', uid);
    let snap;
    try {
      snap = await getDoc(ref);
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, path);
      return;
    }

    if (snap.exists()) {
      const existing = snap.data();
      if (existing?.email === safeEmail && existing?.displayName === safeName) {
        ensuredProfileCache.set(uid, cacheSig);
        return;
      }
      try {
        await updateDoc(ref, {
          email: safeEmail,
          displayName: safeName,
          updatedAt: serverTimestamp(),
        });
        ensuredProfileCache.set(uid, cacheSig);
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, path);
      }
    } else {
      try {
        await setDoc(ref, {
          uid,
          email: safeEmail,
          displayName: safeName,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        ensuredProfileCache.set(uid, cacheSig);
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, path);
      }
    }
  });
}

export async function loadUserWorkspace(userId: string): Promise<CloudWorkspace> {
  if (!canUseCloudSync(userId)) {
    return { guilds: [], squads: [], accounts: [] };
  }
  const uid = sanitizeDocId(userId);
  try {
    const [gSnap, sSnap, aSnap] = await Promise.all([
      getDocs(collection(db, 'users', uid, 'guilds')),
      getDocs(collection(db, 'users', uid, 'squads')),
      getDocs(collection(db, 'users', uid, 'accounts')),
    ]);

    const guilds: Partial<GuildInfo>[] = [];
    gSnap.forEach((d) => {
      const data = d.data();
      guilds.push({
        clan_id: String(data.clan_id || d.id),
        name: String(data.name || `Guild ${d.id}`),
        region: String(data.region || 'BD'),
        verified: Boolean(data.verified),
        duration_days: Number(data.duration_days || 0),
        duration_hours: Number(data.duration_hours || 0),
        duration_minutes: Number(data.duration_minutes || 0),
        expires_at: typeof data.expires_at === 'number' ? data.expires_at : null,
        is_paused: Boolean(data.is_paused),
        created_at: Number(data.created_at || Date.now()),
      });
    });

    const squads: Partial<SquadInfo>[] = [];
    sSnap.forEach((d) => {
      const data = d.data();
      squads.push({
        id: String(data.id || d.id),
        clan_id: String(data.clan_id || ''),
        name: String(data.name || 'Squad'),
        target_size: clamp(Number(data.target_size || 4), 2, 4),
        game_mode: normalizeGameMode(data.game_mode),
        lobby_delay_sec: 0,
        bot_prefix: normalizePrefix(data.bot_prefix),
        is_paused: Boolean(data.is_paused),
        created_at: Number(data.created_at || Date.now()),
      });
    });

    const accounts: SavedAccountRow[] = [];
    aSnap.forEach((d) => {
      const data = d.data();
      if (!data.password) return;
      accounts.push({
        uid: String(data.uid || d.id),
        password: String(data.password),
        region: String(data.region || 'BD'),
        clan_id: String(data.clan_id || ''),
        squad_id: data.squad_id ? String(data.squad_id) : undefined,
        bot_prefix: data.bot_prefix ? normalizePrefix(data.bot_prefix) : undefined,
        nickname: data.nickname ? String(data.nickname) : undefined,
        max_matches: Number(data.max_matches || 0),
        max_hours: Number(data.max_hours || 0),
      });
    });

    return { guilds, squads, accounts };
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, `users/${uid}`);
    return { guilds: [], squads: [], accounts: [] };
  }
}

export async function upsertGuildDoc(
  userId: string,
  guild: Pick<
    GuildInfo,
    | 'clan_id'
    | 'name'
    | 'region'
    | 'verified'
    | 'duration_days'
    | 'duration_hours'
    | 'duration_minutes'
    | 'expires_at'
    | 'is_paused'
    | 'created_at'
  >,
  existsInCloud = false,
): Promise<void> {
  if (!canUseCloudSync(userId)) return;
  const uid = sanitizeDocId(userId);
  const clanId = String(guild.clan_id || '').trim();
  if (!/^[0-9]{1,24}$/.test(clanId)) return;

  const path = `users/${uid}/guilds/${clanId}`;
  await enqueueDocWrite(path, async () => {
    const ref = doc(db, 'users', uid, 'guilds', clanId);
    const mutableFields = {
      name: String(guild.name || `Guild ${clanId}`).slice(0, 80) || `Guild ${clanId}`,
      region: String(guild.region || 'BD').slice(0, 12) || 'BD',
      verified: Boolean(guild.verified),
      duration_days: clamp(Math.floor(Number(guild.duration_days || 0)), 0, 365),
      duration_hours: clamp(Math.floor(Number(guild.duration_hours || 0)), 0, 23),
      duration_minutes: clamp(Math.floor(Number(guild.duration_minutes || 0)), 0, 59),
      expires_at:
        typeof guild.expires_at === 'number' && Number.isFinite(guild.expires_at)
          ? Math.max(0, guild.expires_at)
          : null,
      is_paused: Boolean(guild.is_paused),
      updatedAt: serverTimestamp(),
    };

    try {
      const snap = await getDoc(ref);
      if (snap.exists()) {
        await updateDoc(ref, mutableFields);
      } else {
        await setDoc(ref, {
          clan_id: clanId,
          ...mutableFields,
          created_at: Math.max(0, Number(guild.created_at || Date.now())),
          ownerUid: uid,
          createdAt: serverTimestamp(),
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
  });
}

export async function removeGuildDoc(userId: string, clanId: string): Promise<void> {
  if (!canUseCloudSync(userId)) return;
  const uid = sanitizeDocId(userId);
  const id = sanitizeDocId(clanId);
  if (!id) return;
  const path = `users/${uid}/guilds/${id}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'guilds', id));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function upsertSquadDoc(
  userId: string,
  squad: Pick<
    SquadInfo,
    | 'id'
    | 'clan_id'
    | 'name'
    | 'target_size'
    | 'game_mode'
    | 'lobby_delay_sec'
    | 'bot_prefix'
    | 'is_paused'
    | 'created_at'
  >,
  existsInCloud = false,
): Promise<void> {
  if (!canUseCloudSync(userId)) return;
  const uid = sanitizeDocId(userId);
  const squadId = sanitizeDocId(squad.id);
  if (!squadId) return;

  const path = `users/${uid}/squads/${squadId}`;
  await enqueueDocWrite(path, async () => {
    const ref = doc(db, 'users', uid, 'squads', squadId);
    const mutableFields = {
      clan_id: String(squad.clan_id || '').slice(0, 24),
      name: String(squad.name || 'Squad').slice(0, 64) || 'Squad',
      target_size: clamp(Math.floor(Number(squad.target_size || 4)), 2, 4),
      game_mode: normalizeGameMode(squad.game_mode),
      lobby_delay_sec: 0,
      bot_prefix: normalizePrefix(squad.bot_prefix),
      is_paused: Boolean(squad.is_paused),
      updatedAt: serverTimestamp(),
    };

    try {
      const snap = await getDoc(ref);
      if (snap.exists()) {
        await updateDoc(ref, mutableFields);
      } else {
        await setDoc(ref, {
          id: squadId,
          ...mutableFields,
          created_at: Math.max(0, Number(squad.created_at || Date.now())),
          ownerUid: uid,
          createdAt: serverTimestamp(),
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
  });
}

export async function removeSquadDoc(userId: string, squadId: string): Promise<void> {
  if (!canUseCloudSync(userId)) return;
  const uid = sanitizeDocId(userId);
  const id = sanitizeDocId(squadId);
  if (!id) return;
  const path = `users/${uid}/squads/${id}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'squads', id));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function upsertAccountDoc(
  userId: string,
  row: SavedAccountRow,
  existsInCloud = false,
): Promise<void> {
  if (!canUseCloudSync(userId)) return;
  const uid = sanitizeDocId(userId);
  const accId = sanitizeDocId(row.uid);
  if (!accId || !row.password) return;

  const path = `users/${uid}/accounts/${accId}`;
  await enqueueDocWrite(path, async () => {
    const ref = doc(db, 'users', uid, 'accounts', accId);
    const mutableFields = {
      password: String(row.password).slice(0, 64),
      region: String(row.region || 'BD').slice(0, 12) || 'BD',
      clan_id: String(row.clan_id || '').slice(0, 24),
      squad_id: String(row.squad_id || '').slice(0, 64),
      bot_prefix: String(row.bot_prefix || 'RDX').slice(0, 8),
      nickname: String(row.nickname || '').slice(0, 40),
      max_matches: clamp(Math.floor(Number(row.max_matches || 0)), 0, 100000),
      max_hours: clamp(Math.floor(Number(row.max_hours || 0)), 0, 8760),
      updatedAt: serverTimestamp(),
    };

    try {
      const snap = await getDoc(ref);
      if (snap.exists()) {
        await updateDoc(ref, mutableFields);
      } else {
        await setDoc(ref, {
          uid: accId,
          ...mutableFields,
          ownerUid: uid,
          createdAt: serverTimestamp(),
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
  });
}

export async function removeAccountDoc(userId: string, accountUid: string): Promise<void> {
  if (!canUseCloudSync(userId)) return;
  const uid = sanitizeDocId(userId);
  const accId = sanitizeDocId(accountUid);
  if (!accId) return;
  const path = `users/${uid}/accounts/${accId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'accounts', accId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function clearUserAccountDocs(userId: string): Promise<void> {
  if (!canUseCloudSync(userId)) return;
  const uid = sanitizeDocId(userId);
  const colPath = `users/${uid}/accounts`;
  try {
    const snap = await getDocs(collection(db, 'users', uid, 'accounts'));
    if (snap.empty) return;
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 400) {
      const batch = writeBatch(db);
      for (const d of docs.slice(i, i + 400)) {
        batch.delete(d.ref);
      }
      await batch.commit();
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, colPath);
  }
}
