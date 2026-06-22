// Multi-device sync via a self-hosted PocketBase. Purely additive: every call
// is wrapped so a down/misconfigured backend never breaks the app. Strategy is
// last-write-wins per conversation (by updatedAt) + whole-blob LWW for settings.
import { store } from './state';
import type { Conversation, Settings } from './types';
import { getKv, setKv, listConversations } from './db';

// Settings that must stay device-local and never leave this machine.
const LOCAL_KEYS: (keyof Settings)[] = [
  'proxy_password', 'st_basic_pass', 'sync_enabled', 'sync_url', 'sync_email', 'sync_password',
];

let token = '';
let userId = '';
let syncing = false;
let dirty = false;
let debounceTimer: number | null = null;
let pollTimer: number | null = null;

export type SyncStatus = { state: 'off' | 'connecting' | 'synced' | 'error'; detail?: string; at?: number };
let status: SyncStatus = { state: 'off' };
let statusCb: ((s: SyncStatus) => void) | null = null;
export function onStatus(cb: ((s: SyncStatus) => void) | null) { statusCb = cb; }
export function getStatus(): SyncStatus { return status; }
function setStatus(s: SyncStatus) { status = s; statusCb?.(s); }

function base(): string { return (store.settings.sync_url || '').replace(/\/$/, ''); }

async function api(path: string, opts: RequestInit = {}): Promise<any> {
  const r = await fetch(base() + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: token } : {}),
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`PocketBase ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}

async function authenticate(): Promise<void> {
  const s = store.settings;
  if (!s.sync_url || !s.sync_email || !s.sync_password) throw new Error('Fill the PocketBase URL, email & password first');
  const res = await api('/api/collections/users/auth-with-password', {
    method: 'POST',
    body: JSON.stringify({ identity: s.sync_email, password: s.sync_password }),
  });
  token = res?.token || '';
  userId = res?.record?.id || '';
  if (!token) throw new Error('Login failed');
}

type RemoteRec = { id: string; syncTs: number; data: any };
async function remoteList(): Promise<Map<string, RemoteRec>> {
  const map = new Map<string, RemoteRec>();
  let page = 1;
  while (true) {
    const res = await api(`/api/collections/store/records?perPage=200&page=${page}`);
    for (const it of res.items || []) map.set(it.key, { id: it.id, syncTs: it.syncTs || 0, data: it.data });
    if (!res.totalPages || page >= res.totalPages) break;
    page++;
  }
  return map;
}

async function upsert(existing: RemoteRec | undefined, key: string, data: any, syncTs: number): Promise<void> {
  const body = JSON.stringify({ key, data, syncTs, owner: userId });
  if (existing) await api(`/api/collections/store/records/${existing.id}`, { method: 'PATCH', body });
  else await api('/api/collections/store/records', { method: 'POST', body });
}

async function syncNow(): Promise<void> {
  if (!store.settings.sync_enabled) return;
  if (!token) { setStatus({ state: 'connecting' }); await authenticate(); }

  const remote = await remoteList();
  const localConvs = await listConversations();
  const localById = new Map(localConvs.map(c => [c.id, c]));
  const prevSynced: string[] = (await getKv<string[]>('syncedConvIds')) || [];
  const remoteConvKeys = [...remote.keys()].filter(k => k !== 'settings');

  // Deletions that happened on another device: previously synced, still local, gone remotely.
  const toDeleteLocal = prevSynced.filter(id => localById.has(id) && !remote.has(id));
  const deleteSet = new Set(toDeleteLocal);

  // Pulls: remote conversation is newer than local (or local is missing it).
  const toApply: Conversation[] = [];
  for (const key of remoteConvKeys) {
    const r = remote.get(key)!;
    const local = localById.get(key);
    if (!local || r.syncTs > (local.updatedAt || 0)) toApply.push(r.data as Conversation);
  }

  // Pushes: local conversation is newer than remote (or remote is missing it).
  for (const c of localConvs) {
    if (deleteSet.has(c.id)) continue;
    const r = remote.get(c.id);
    if (!r || (c.updatedAt || 0) > r.syncTs) await upsert(r, c.id, c, c.updatedAt || Date.now());
  }

  // Settings (whole-blob LWW, secrets stripped).
  const rs = remote.get('settings');
  const localSettingsAt = (await getKv<number>('settingsUpdatedAt')) || 0;
  if (rs && rs.syncTs > localSettingsAt) {
    const merged: any = { ...store.settings, ...rs.data };
    for (const k of LOCAL_KEYS) merged[k] = store.settings[k]; // never overwrite local secrets
    await store.updateSettings(merged, { syncedAt: rs.syncTs });
  } else {
    const out: any = { ...store.settings };
    for (const k of LOCAL_KEYS) delete out[k];
    await upsert(rs, 'settings', out, localSettingsAt || Date.now());
  }

  // Apply pulled conversations + remote deletions to the local db.
  if (toApply.length || toDeleteLocal.length) await store.applyRemote(toApply, toDeleteLocal);

  // Remember what's known-synced so we can detect future deletions.
  const known = [...new Set([...remoteConvKeys, ...localConvs.filter(c => !deleteSet.has(c.id)).map(c => c.id)])];
  await setKv('syncedConvIds', known);

  setStatus({ state: 'synced', at: Date.now() });
}

// Debounced, re-entrancy-safe runner. Local mutations call scheduleSync().
function runSync(): void {
  if (!store.settings.sync_enabled) return;
  if (syncing) { dirty = true; return; }
  syncing = true; dirty = false;
  syncNow()
    .catch(e => setStatus({ state: 'error', detail: (e as Error).message, at: Date.now() }))
    .finally(() => {
      syncing = false;
      if (dirty) scheduleSync();
    });
}

export function scheduleSync(delay = 1500): void {
  if (!store.settings.sync_enabled) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(runSync, delay);
}

// Called once at startup (and when the user hits "Sync now"/toggles sync on).
export async function startSync(): Promise<void> {
  // The store calls this after every local change; guarded so applyRemote's own
  // writes (which go straight to the db, not via saveCurrent) don't echo.
  store.syncHook = () => scheduleSync();
  if (!store.settings.sync_enabled) { setStatus({ state: 'off' }); return; }
  setStatus({ state: 'connecting' });
  try {
    await authenticate();
    await syncNow();
  } catch (e) {
    setStatus({ state: 'error', detail: (e as Error).message, at: Date.now() });
  }
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = window.setInterval(() => { if (store.settings.sync_enabled && !syncing) scheduleSync(0); }, 20000);
}

// "Sync now" button + connecting after entering creds.
export async function syncNowManual(): Promise<void> {
  token = ''; // force re-auth in case creds changed
  await startSync();
  if (status.state === 'error') throw new Error(status.detail || 'Sync failed');
}
