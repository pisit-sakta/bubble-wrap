import { openDB, type IDBPDatabase } from 'idb';
import type { Conversation, Message, Settings } from './types';

const DB_NAME = 'bubble';
const DB_VERSION = 2;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('conversations')) {
          const store = db.createObjectStore('conversations', { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv');
        }
        // Audio/video attachments, keyed by attachment id. Kept out of the conversation
        // record so a 60 MB recording isn't rewritten on every save or pushed to sync.
        if (!db.objectStoreNames.contains('blobs')) {
          db.createObjectStore('blobs');
        }
      },
    });
  }
  return dbPromise;
}

export async function listConversations(): Promise<Conversation[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex('conversations', 'updatedAt');
  return all.reverse();
}

export async function getConversation(id: string): Promise<Conversation | undefined> {
  const db = await getDb();
  return db.get('conversations', id);
}

export async function saveConversation(c: Conversation): Promise<void> {
  const db = await getDb();
  await db.put('conversations', c);
}

export async function deleteConversation(id: string): Promise<void> {
  const db = await getDb();
  // Its recordings go with it — nothing else points at them.
  const c: Conversation | undefined = await db.get('conversations', id);
  const walk = (msgs: Message[] = []): string[] => msgs.flatMap(m => [
    ...(m.attachments || []).filter(a => a.kind === 'media').map(a => a.id),
    ...(m.variants || []).flatMap(v => [
      ...(v.attachments || []).filter(a => a.kind === 'media').map(a => a.id),
      ...walk(v.downstreamSnapshot),
    ]),
  ]);
  for (const blobId of new Set(walk(c?.messages))) await db.delete('blobs', blobId);
  await db.delete('conversations', id);
}

export async function putBlob(id: string, blob: Blob): Promise<void> {
  const db = await getDb();
  await db.put('blobs', blob, id);
}

export async function getBlob(id: string): Promise<Blob | undefined> {
  const db = await getDb();
  return db.get('blobs', id);
}

export async function loadSettings(): Promise<Settings | undefined> {
  const db = await getDb();
  return db.get('kv', 'settings');
}

export async function saveSettings(s: Settings): Promise<void> {
  const db = await getDb();
  await db.put('kv', s, 'settings');
}

export async function getKv<T = unknown>(key: string): Promise<T | undefined> {
  const db = await getDb();
  return db.get('kv', key);
}

export async function setKv(key: string, val: unknown): Promise<void> {
  const db = await getDb();
  await db.put('kv', val, key);
}
