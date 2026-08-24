// gems-board.js — the on-device inspiration board (a Pinterest-style board).
// Photos and Discover looks the user pins to "take inspo from" live here in
// their own IndexedDB store, so the board works fully offline and in demo. When
// the user is signed in, Discover pins ALSO sync to the Supabase moodboard
// (gems-moodboards.js) so counts line up across devices.
//
// Every function degrades to a silent no-op / empty result rather than throwing.

const DB_NAME = "gems-board";
const DB_VERSION = 1;
const STORE = "pins";

let dbPromise = null;

function openDB() {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch (error) {
      console.info("Board DB unavailable", error);
      resolve(null);
    }
  });
  return dbPromise;
}

// Run one IndexedDB request and resolve with its result (never rejects).
async function idbRequest(mode, makeRequest) {
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const req = makeRequest(store);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch (error) {
      console.info("Board request failed", error);
      resolve(null);
    }
  });
}

// A stable de-dupe key so the same photo/look is only pinned once.
function keyFor(item) {
  if (item.photoId) return `photo:${item.photoId}`;
  if (item.cardId) return `discover:${item.cardId}`;
  if (item.url) return `url:${item.url}`;
  return `misc:${item.title || ""}`;
}

/**
 * Pin an item to the board. Accepts a user photo ({photoId, url, title}) or a
 * Discover look ({cardId, scene, title, credit, categories}). Idempotent on key.
 * @returns {Promise<{pinned:boolean, already:boolean}>}
 */
export async function pinToBoard(item = {}) {
  try {
    const key = keyFor(item);
    const existing = await idbRequest("readonly", (store) => store.get(key));
    if (existing) return { pinned: false, already: true };
    const record = {
      id: key,
      photoId: item.photoId ?? null,
      cardId: item.cardId ?? null,
      url: item.url ?? null,
      scene: item.scene ?? null,
      title: item.title ?? null,
      credit: item.credit ?? null,
      categories: Array.isArray(item.categories) ? item.categories : [],
      source: item.photoId ? "photo" : item.cardId ? "discover" : "other",
      pinnedAt: item.pinnedAt ?? Date.now(),
    };
    await idbRequest("readwrite", (store) => store.put(record));
    return { pinned: true, already: false };
  } catch (error) {
    console.info("pinToBoard failed", error);
    return { pinned: false, already: false };
  }
}

/** All pinned items, newest first (falls back to insertion order). */
export async function listBoardItems() {
  const db = await openDB();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const rows = Array.isArray(req.result) ? req.result : [];
        rows.sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
        resolve(rows);
      };
      req.onerror = () => resolve([]);
    } catch (error) {
      console.info("listBoardItems failed", error);
      resolve([]);
    }
  });
}

export async function removeFromBoard(id) {
  await idbRequest("readwrite", (store) => store.delete(id));
  return true;
}

export async function boardCount() {
  const db = await openDB();
  if (!db) return 0;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => resolve(0);
    } catch {
      resolve(0);
    }
  });
}

export async function isPinned(item) {
  const db = await openDB();
  if (!db) return false;
  const key = keyFor(item);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(Boolean(req.result));
      req.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}
