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
let hideHooked = false;

export type SyncStatus = { state: 'off' | 'connecting' | 'synced' | 'error'; detail?: string; at?: number };
let status: SyncStatus = { state: 'off' };
let statusCb: ((s: SyncStatus) => void) | null = null;
export function onStatus(cb: ((s: SyncStatus) => void) | null) { statusCb = cb; }
export function getStatus(): SyncStatus { return status; }
function setStatus(s: SyncStatus) { status = s; statusCb?.(s); }

function base(): string {
  let u = (store.settings.sync_url || '').trim().replace(/\/$/, '');
  // A schemeless URL makes fetch() treat it as a path on the current origin
  // (GitHub Pages → POST → 405). Default to https:// so the host is honored.
  if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

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
  // Mobile keyboards love sneaking in trailing spaces / autocapitalization;
  // trim the identity so invisible whitespace can't cause a phantom 400.
  const res = await api('/api/collections/users/auth-with-password', {
    method: 'POST',
    body: JSON.stringify({ identity: s.sync_email.trim(), password: s.sync_password.trim() }),
  });
  token = res?.token || '';
  userId = res?.record?.id || '';
  if (!token) throw new Error('Login failed');
}

// Delta sync: we fetch lightweight METADATA (key + syncTs) for every record first,
// then download the heavy `data` blob ONLY for records that actually changed. This
// turns an idle poll from "re-download the entire chat history" into one tiny request.
type RemoteMeta = { id: string; syncTs: number };
async function remoteMeta(): Promise<Map<string, RemoteMeta>> {
  const map = new Map<string, RemoteMeta>();
  let page = 1;
  while (true) {
    // `fields=` projects away the fat `data` column — a few hundred bytes per record
    // regardless of how many base64 photos/PDFs the conversation holds.
    const res = await api(`/api/collections/store/records?perPage=200&page=${page}&fields=id,key,syncTs`);
    for (const it of res.items || []) map.set(it.key, { id: it.id, syncTs: it.syncTs || 0 });
    if (!res.totalPages || page >= res.totalPages) break;
    page++;
  }
  return map;
}

// Fetch the full `data` blobs for just the given PocketBase record ids (the changed
// ones). Batched by id-filter so we never page through untouched conversations.
async function remoteData(ids: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  const CHUNK = 40;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const filter = encodeURIComponent(slice.map(id => `id='${id}'`).join(' || '));
    const res = await api(`/api/collections/store/records?perPage=${slice.length}&filter=${filter}&fields=id,data`);
    for (const it of res.items || []) out.set(it.id, it.data);
  }
  return out;
}

async function upsert(existing: { id: string } | undefined, key: string, data: any, syncTs: number): Promise<void> {
  const body = JSON.stringify({ key, data, syncTs, owner: userId });
  if (existing) await api(`/api/collections/store/records/${existing.id}`, { method: 'PATCH', body });
  else await api('/api/collections/store/records', { method: 'POST', body });
}

async function syncNow(): Promise<void> {
  if (!store.settings.sync_enabled) return;
  if (!token) { setStatus({ state: 'connecting' }); await authenticate(); }

  const meta = await remoteMeta();
  const localConvs = await listConversations();
  const localById = new Map(localConvs.map(c => [c.id, c]));
  const prevSynced: string[] = (await getKv<string[]>('syncedConvIds')) || [];
  const remoteConvKeys = [...meta.keys()].filter(k => k !== 'settings');

  // Deletions that happened on another device: previously synced, still local, gone
  // remotely. Metadata covers EVERY record, so delete-detection stays fully correct.
  const toDeleteLocal = prevSynced.filter(id => localById.has(id) && !meta.has(id));
  const deleteSet = new Set(toDeleteLocal);

  // Decide which conversations are newer remotely (so we must pull their blob) — by
  // comparing timestamps only. No `data` has been downloaded yet at this point.
  const pullKeys: string[] = [];
  for (const key of remoteConvKeys) {
    const m = meta.get(key)!;
    const local = localById.get(key);
    if (!local || m.syncTs > (local.updatedAt || 0)) pullKeys.push(key);
  }

  // Settings (whole-blob LWW): pull if remote is newer, push if local is strictly
  // newer (or missing remotely), else leave it — so an unchanged poll moves no bytes.
  const rsMeta = meta.get('settings');
  const localSettingsAt = (await getKv<number>('settingsUpdatedAt')) || 0;
  const pullSettings = !!(rsMeta && rsMeta.syncTs > localSettingsAt);
  const pushSettings = !rsMeta || localSettingsAt > rsMeta.syncTs;

  // Download the heavy blobs for ONLY the changed records (idle poll → empty → no
  // blob traffic at all).
  const needData = pullKeys.map(k => meta.get(k)!.id);
  if (pullSettings) needData.push(rsMeta!.id);
  const blobs = needData.length ? await remoteData(needData) : new Map<string, any>();

  const toApply: Conversation[] = [];
  for (const key of pullKeys) {
    const data = blobs.get(meta.get(key)!.id);
    if (data) toApply.push(data as Conversation);
  }

  // Pushes: local conversation is newer than remote (or remote is missing it).
  // Each upsert is isolated so one bad chat (e.g. too large for the backend's JSON
  // field limit) gets skipped-with-a-warning instead of aborting the whole sync.
  const failed: string[] = [];
  for (const c of localConvs) {
    if (deleteSet.has(c.id)) continue;
    const m = meta.get(c.id);
    if (!m || (c.updatedAt || 0) > m.syncTs) {
      try {
        await upsert(m, c.id, c, c.updatedAt || Date.now());
      } catch (e) {
        failed.push(c.title || c.id);
        console.warn(`[sync] skipped "${c.title || c.id}":`, (e as Error).message);
      }
    }
  }

  if (pullSettings) {
    const data = blobs.get(rsMeta!.id);
    if (data) {
      const merged: any = { ...store.settings, ...data };
      for (const k of LOCAL_KEYS) merged[k] = store.settings[k]; // never overwrite local secrets
      await store.updateSettings(merged, { syncedAt: rsMeta!.syncTs });
    }
  } else if (pushSettings) {
    const out: any = { ...store.settings };
    for (const k of LOCAL_KEYS) delete out[k];
    const pushTs = localSettingsAt || Date.now();
    await upsert(rsMeta, 'settings', out, pushTs);
    await setKv('settingsUpdatedAt', pushTs); // avoid re-pulling our own settings next poll
  }

  // Apply pulled conversations + remote deletions to the local db.
  if (toApply.length || toDeleteLocal.length) await store.applyRemote(toApply, toDeleteLocal);

  // Remember what's known-synced so we can detect future deletions.
  const known = [...new Set([...remoteConvKeys, ...localConvs.filter(c => !deleteSet.has(c.id)).map(c => c.id)])];
  await setKv('syncedConvIds', known);

  if (failed.length) {
    const names = failed.slice(0, 3).join(', ') + (failed.length > 3 ? `, +${failed.length - 3} more` : '');
    setStatus({ state: 'error', detail: `Synced, but ${failed.length} chat(s) too large to upload: ${names}`, at: Date.now() });
  } else {
    setStatus({ state: 'synced', at: Date.now() });
  }
}

// Debounced, re-entrancy-safe runner. Local mutations call scheduleSync().
function runSync(): void {
  if (!store.settings.sync_enabled) return;
  // Never push a mid-stream conversation: the assistant message is still empty/partial
  // in the db until onDone commits it. Pushing now would sync a reply-less turn and the
  // real reply might never make it up (see the immediate flush on completion in ui.ts).
  if (store.streaming) { dirty = true; return; }
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

  // Best-effort flush when the tab is backgrounded/closed, so a just-finished reply
  // isn't stranded by the debounce when a mobile user immediately locks their phone.
  if (!hideHooked) {
    hideHooked = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && store.settings.sync_enabled && !store.streaming && !syncing) runSync();
    });
  }
}

// "Sync now" button + connecting after entering creds.
export async function syncNowManual(): Promise<void> {
  token = ''; // force re-auth in case creds changed
  await startSync();
  if (status.state === 'error') throw new Error(status.detail || 'Sync failed');
}
