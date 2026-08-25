// gems-embeddings.js — on-device visual + text embeddings (CLIP).
//
// Turns the camera roll from an opaque blob into a queryable index. A CLIP model
// (loaded from a CDN via transformers.js, same lazy-guarded pattern as the face
// and segmenter models) encodes each photo into a ~512-d vector on-device; text
// queries encode into the SAME space, so cosine similarity gives real semantic
// search ("red dress rooftop sunset"). The vectors also power perceptual
// near-duplicate / burst detection — far better than comparing caption words.
//
// Everything is on-device; only the numeric vectors persist (IndexedDB). Degrades
// to "unavailable" if the model can't load. Never throws.
//
// Pure vector helpers (dot / normalize / topK / grouping) carry no browser
// dependency and are unit-tested.

const LIB_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3";
const MODEL_ID = "Xenova/clip-vit-base-patch32";
import { ensureDbUser, dbNameFor, onDbUserChange } from "./gems-db-user.js";

const DB_NAME = "gems-embeddings";
const DB_VERSION = 1;
const DUP_THRESHOLD = 0.93; // cosine ≥ this → near-duplicate / same burst frame

// ---------------------------------------------------------------------------
// Pure vector math (unit-tested).
// ---------------------------------------------------------------------------

export function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/** Return an L2-normalized copy (so cosine similarity = dot product). */
export function l2normalize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/** Cosine similarity of two UNIT vectors (= dot). Use l2normalize on store. */
export const cosineUnit = dot;

/**
 * Top-k items by cosine similarity to a unit query vector. items: [{id, vec}]
 * with unit vecs. Returns [{ id, score }] sorted desc.
 */
export function topKByCosine(queryVec, items, k = 30) {
  const scored = items.map((it) => ({ id: it.id, score: dot(queryVec, it.vec) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/**
 * Group items whose vectors are within `threshold` cosine of each other
 * (near-duplicates / burst frames). Greedy single-link. items: [{id, vec}] unit.
 * Returns an array of groups (each an array of ids); singletons included.
 */
export function groupByCosine(items, threshold = DUP_THRESHOLD) {
  const groups = [];
  const used = new Set();
  for (let i = 0; i < items.length; i++) {
    if (used.has(items[i].id)) continue;
    const group = [items[i].id];
    used.add(items[i].id);
    for (let j = i + 1; j < items.length; j++) {
      if (used.has(items[j].id)) continue;
      if (dot(items[i].vec, items[j].vec) >= threshold) {
        group.push(items[j].id);
        used.add(items[j].id);
      }
    }
    groups.push(group);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Model loading (browser only).
// ---------------------------------------------------------------------------

let modelsPromise = null;

export function canEmbed() {
  return typeof window !== "undefined" && typeof indexedDB !== "undefined" && typeof WebAssembly !== "undefined";
}

async function getModels() {
  if (modelsPromise) return modelsPromise;
  modelsPromise = (async () => {
    const t = await import(/* @vite-ignore */ LIB_URL);
    const {
      AutoTokenizer, CLIPTextModelWithProjection, AutoProcessor, CLIPVisionModelWithProjection, env,
    } = t;
    if (env) env.allowLocalModels = false; // fetch weights from the HF CDN
    const [tokenizer, textModel, processor, visionModel] = await Promise.all([
      AutoTokenizer.from_pretrained(MODEL_ID),
      CLIPTextModelWithProjection.from_pretrained(MODEL_ID),
      AutoProcessor.from_pretrained(MODEL_ID),
      CLIPVisionModelWithProjection.from_pretrained(MODEL_ID),
    ]);
    return { t, tokenizer, textModel, processor, visionModel };
  })().catch((error) => {
    console.info("Embeddings model unavailable — semantic search off", error);
    modelsPromise = null;
    return null;
  });
  return modelsPromise;
}

/** Encode a text query into a unit vector (or null if unavailable). */
export async function embedText(text) {
  try {
    const q = String(text || "").trim();
    if (!q || !canEmbed()) return null;
    const m = await getModels();
    if (!m) return null;
    const inputs = await m.tokenizer([q], { padding: true, truncation: true });
    const { text_embeds } = await m.textModel(inputs);
    return l2normalize(Array.from(text_embeds.data));
  } catch (error) {
    console.info("embedText failed", error);
    return null;
  }
}

/** Encode an image (Blob) into a unit vector (or null if unavailable). */
export async function embedImageBlob(blob) {
  try {
    if (!blob || !canEmbed()) return null;
    const m = await getModels();
    if (!m) return null;
    const image = await m.t.RawImage.fromBlob(blob);
    const inputs = await m.processor(image);
    const { image_embeds } = await m.visionModel(inputs);
    return l2normalize(Array.from(image_embeds.data));
  } catch (error) {
    console.info("embedImageBlob failed", error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// IndexedDB store.  vecs: { photoId, vec:number[] }   meta: { key, value }
// ---------------------------------------------------------------------------

let dbPromise = null;
// Reset the embedding index on account switch so vectors never bleed between accounts.
onDbUserChange(() => {
  const prev = dbPromise;
  dbPromise = null;
  if (prev) prev.then((db) => { try { db?.close?.(); } catch { /* already closed */ } }).catch(() => {});
});
async function openDb() {
  await ensureDbUser(); // partition the embedding DB by the signed-in account
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(dbNameFor(DB_NAME), DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("vecs")) db.createObjectStore("vecs", { keyPath: "photoId" });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}
function store(db, name, mode) {
  return db.transaction(name, mode).objectStore(name);
}
function reqP(request) {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

export async function isIndexed(photoId) {
  const db = await openDb();
  if (!db) return false;
  return !!(await reqP(store(db, "vecs", "readonly").get(photoId)));
}

/** Index one photo (compute + store its vector). Idempotent. Returns bool. */
export async function indexPhoto(photoId, blob) {
  const db = await openDb();
  if (!db) return false;
  if (await isIndexed(photoId)) return true;
  const vec = await embedImageBlob(blob);
  if (!vec) return false;
  await reqP(store(db, "vecs", "readwrite").put({ photoId, vec }));
  return true;
}

/**
 * Index up to `limit` not-yet-indexed photos. getBlob(photoId) → Blob.
 * Returns { indexed }.
 */
export async function indexBatch(photoIds, getBlob, limit = 40) {
  if (!canEmbed()) return { indexed: 0 };
  let indexed = 0;
  for (const id of photoIds) {
    if (indexed >= limit) break;
    if (await isIndexed(id)) continue;
    let blob = null;
    try {
      blob = await getBlob(id);
    } catch {
      blob = null;
    }
    if (!blob) continue;
    if (await indexPhoto(id, blob)) indexed += 1;
  }
  return { indexed };
}

async function allVecs() {
  const db = await openDb();
  if (!db) return [];
  const rows = (await reqP(store(db, "vecs", "readonly").getAll())) || [];
  return rows.map((r) => ({ id: r.photoId, vec: r.vec }));
}

export async function indexedCount() {
  return (await allVecs()).length;
}

/**
 * Semantic search: returns [{ photoId, score }] for the query, best first, or
 * null when embeddings are unavailable or the index is empty (caller falls back).
 * Only returns matches above `minScore` (CLIP text-image cosine is modest).
 */
export async function searchPhotos(query, k = 40, minScore = 0.2) {
  const items = await allVecs();
  if (!items.length) return null;
  const qvec = await embedText(query);
  if (!qvec) return null;
  return topKByCosine(qvec, items, k)
    .filter((r) => r.score >= minScore)
    .map((r) => ({ photoId: r.id, score: r.score }));
}

/**
 * Perceptual near-duplicate / burst groups over the indexed library. Returns
 * groups of photoIds (2+ members = a burst/dup set), or null if unavailable.
 */
export async function duplicateGroups(threshold = DUP_THRESHOLD) {
  const items = await allVecs();
  if (!items.length) return null;
  return groupByCosine(items, threshold).filter((g) => g.length > 1);
}

/**
 * Given a set of candidate photoIds, return a cosine-similarity lookup so callers
 * (e.g. dump assembly) can skip near-duplicates. Returns a function
 * (idA, idB) -> similarity in [-1,1], or null when embeddings are unavailable.
 */
export async function similarityLookup() {
  const items = await allVecs();
  if (!items.length) return null;
  const byId = new Map(items.map((it) => [it.id, it.vec]));
  return (idA, idB) => {
    const a = byId.get(idA);
    const b = byId.get(idB);
    if (!a || !b) return null;
    return dot(a, b);
  };
}

export async function clearIndex() {
  const db = await openDb();
  if (!db) return;
  await reqP(store(db, "vecs", "readwrite").clear());
  await reqP(store(db, "meta", "readwrite").clear());
}
