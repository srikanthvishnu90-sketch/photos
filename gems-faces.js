// gems-faces.js — on-device face recognition + identity clustering.
//
// The foundation for "photos of me / of a person" and, later, identity-locked
// generation. Everything runs IN THE BROWSER: faces are detected and turned into
// 128-d descriptors with face-api.js (loaded from a CDN, same pattern as the
// person segmenter), clustered into people, and stored in IndexedDB. Only the
// numeric embeddings ever persist — never the face crops, and nothing leaves the
// device. Degrades to an "unavailable" state if the model can't load; never throws.
//
// Pure helpers (distance, normalize, clustering) are exported for unit tests and
// carry no browser dependency.

const FACEAPI_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/dist/face-api.esm.js";
const MODELS_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model";
// face-api's own guidance: descriptors of the same person are < ~0.6 apart
// (euclidean). We cluster a touch tighter to avoid merging similar-looking people.
const MATCH_THRESHOLD = 0.56;
import { ensureDbUser, dbNameFor, onDbUserChange } from "./gems-db-user.js";

const DB_NAME = "gems-faces";
const DB_VERSION = 1;

// ---------------------------------------------------------------------------
// Pure math (no DOM / no network) — unit-tested.
// ---------------------------------------------------------------------------

/** Euclidean distance between two equal-length numeric arrays. */
export function euclidean(a, b) {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** Cosine similarity (1 = identical direction). */
export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Mean of a list of equal-length vectors. */
export function centroid(vectors) {
  if (!vectors.length) return [];
  const dim = vectors[0].length;
  const out = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i] += v[i];
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
}

/**
 * Greedy online clustering of face descriptors into people. Each item is
 * { id, descriptor }. Returns a Map itemId -> clusterId (0-based). A descriptor
 * joins the nearest existing cluster whose centroid is within `threshold`
 * (euclidean); otherwise it starts a new cluster. Deterministic given input order.
 */
export function clusterDescriptors(items, threshold = MATCH_THRESHOLD) {
  const clusters = []; // { members:[descriptor], center:[...] }
  const assignment = new Map();
  for (const item of items) {
    const d = item.descriptor;
    let best = -1;
    let bestDist = Infinity;
    for (let c = 0; c < clusters.length; c++) {
      const dist = euclidean(d, clusters[c].center);
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    }
    if (best !== -1 && bestDist <= threshold) {
      clusters[best].members.push(d);
      clusters[best].center = centroid(clusters[best].members);
      assignment.set(item.id, best);
    } else {
      clusters.push({ members: [d], center: d.slice() });
      assignment.set(item.id, clusters.length - 1);
    }
  }
  return assignment;
}

// ---------------------------------------------------------------------------
// Model loading (browser only).
// ---------------------------------------------------------------------------

let faceApiPromise = null;

/** Is on-device face recognition even possible here? */
export function canRecognizeFaces() {
  return (
    typeof window !== "undefined" &&
    typeof indexedDB !== "undefined" &&
    typeof WebAssembly !== "undefined" &&
    typeof createImageBitmap !== "undefined"
  );
}

async function getFaceApi() {
  if (faceApiPromise) return faceApiPromise;
  faceApiPromise = (async () => {
    const faceapi = await import(/* @vite-ignore */ FACEAPI_URL);
    // TinyFaceDetector is small + fast; 68-landmarks aligns the crop; the
    // recognition net produces the 128-d descriptor.
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODELS_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODELS_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODELS_URL);
    return faceapi;
  })().catch((error) => {
    console.info("Face recognition unavailable — skipping", error);
    faceApiPromise = null; // allow a later retry
    return null;
  });
  return faceApiPromise;
}

/**
 * Detect faces in a bitmap and return their 128-d descriptors + boxes.
 * @returns {Promise<Array<{ box:{x,y,w,h}, descriptor:number[] }>>}
 */
// face-api only accepts an HTMLImageElement / HTMLVideoElement /
// HTMLCanvasElement / tf.Tensor3D. Callers here hand us an ImageBitmap (that's
// what createImageBitmap and the photo store produce), which face-api rejects
// with "toNetInput - expected media to be of type…" — detection then returned
// NO FACES for every caller, silently disabling identity-lock and the People
// scan. Draw anything else onto a real canvas first.
function toDetectableMedia(media) {
  if (!media) return null;
  const isElement =
    (typeof HTMLCanvasElement !== "undefined" && media instanceof HTMLCanvasElement) ||
    (typeof HTMLImageElement !== "undefined" && media instanceof HTMLImageElement) ||
    (typeof HTMLVideoElement !== "undefined" && media instanceof HTMLVideoElement);
  if (isElement) return media;
  const w = media.width || media.naturalWidth || 0;
  const h = media.height || media.naturalHeight || 0;
  if (!w || !h || typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(media, 0, 0);
  return canvas;
}

export async function detectAndEmbed(bitmap) {
  try {
    if (!bitmap || !canRecognizeFaces()) return [];
    const faceapi = await getFaceApi();
    if (!faceapi) return [];
    const media = toDetectableMedia(bitmap);
    if (!media) return [];
    const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 });
    const results = await faceapi
      .detectAllFaces(media, opts)
      .withFaceLandmarks()
      .withFaceDescriptors();
    return (results || []).map((r) => ({
      box: {
        x: Math.round(r.detection.box.x),
        y: Math.round(r.detection.box.y),
        w: Math.round(r.detection.box.width),
        h: Math.round(r.detection.box.height),
      },
      descriptor: Array.from(r.descriptor),
    }));
  } catch (error) {
    console.info("detectAndEmbed failed", error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// IndexedDB persistence.
//   faces:  { id: `${photoId}:${idx}`, photoId, box, descriptor, personId }
//   people: { id, name, isMe, size }
//   meta:   { key, value }  (e.g. enrolled photo ids)
// ---------------------------------------------------------------------------

let dbPromise = null;

// Reset the face store on account switch so faces never bleed between accounts.
onDbUserChange(() => {
  const prev = dbPromise;
  dbPromise = null;
  if (prev) prev.then((db) => { try { db?.close?.(); } catch { /* already closed */ } }).catch(() => {});
});

async function openDb() {
  await ensureDbUser(); // partition the face DB by the signed-in account
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(dbNameFor(DB_NAME), DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("faces")) {
          const s = db.createObjectStore("faces", { keyPath: "id" });
          s.createIndex("photoId", "photoId", { unique: false });
          s.createIndex("personId", "personId", { unique: false });
        }
        if (!db.objectStoreNames.contains("people")) db.createObjectStore("people", { keyPath: "id" });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        console.info("faces DB open failed", req.error);
        resolve(null);
      };
    } catch (error) {
      console.info("faces DB unavailable", error);
      resolve(null);
    }
  });
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}
function reqToPromise(request) {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}
function getAll(store) {
  return reqToPromise(store.getAll());
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/** Has a photo already been scanned for faces? */
export async function isEnrolled(photoId) {
  const db = await openDb();
  if (!db) return false;
  const meta = await reqToPromise(tx(db, "meta", "readonly").get(`enrolled:${photoId}`));
  return !!meta;
}

/**
 * Detect + store all faces in one photo. Idempotent per photo. Returns the
 * number of faces found (0 if none / unavailable). Does NOT re-cluster — call
 * rebuildClusters() after a batch for efficiency.
 */
export async function enrollPhoto(photoId, bitmap) {
  const db = await openDb();
  if (!db) return 0;
  if (await isEnrolled(photoId)) return 0;
  const faces = await detectAndEmbed(bitmap);
  const store = tx(db, "faces", "readwrite");
  faces.forEach((f, idx) => {
    store.put({ id: `${photoId}:${idx}`, photoId, box: f.box, descriptor: f.descriptor, personId: null });
  });
  await reqToPromise(tx(db, "meta", "readwrite").put({ key: `enrolled:${photoId}`, value: Date.now(), faces: faces.length }));
  return faces.length;
}

/**
 * Enroll a batch of photos that haven't been scanned yet. `loadBitmap(photoId)`
 * must resolve a drawable bitmap. Processes up to `limit` and re-clusters once.
 * Returns { scanned, faces }.
 */
export async function enrollBatch(photoIds, loadBitmap, limit = 40) {
  if (!canRecognizeFaces()) return { scanned: 0, faces: 0 };
  let scanned = 0;
  let faces = 0;
  for (const photoId of photoIds) {
    if (scanned >= limit) break;
    if (await isEnrolled(photoId)) continue;
    let bitmap = null;
    try {
      bitmap = await loadBitmap(photoId);
    } catch {
      bitmap = null;
    }
    if (!bitmap) continue;
    faces += await enrollPhoto(photoId, bitmap);
    scanned += 1;
  }
  if (scanned) await rebuildClusters();
  return { scanned, faces };
}

/** Re-cluster every stored face into people, preserving names / "me" flags. */
export async function rebuildClusters() {
  const db = await openDb();
  if (!db) return;
  const faces = (await getAll(tx(db, "faces", "readonly"))) || [];
  if (!faces.length) return;
  const prevPeople = (await getAll(tx(db, "people", "readonly"))) || [];

  const assignment = clusterDescriptors(
    faces.map((f) => ({ id: f.id, descriptor: f.descriptor })),
    MATCH_THRESHOLD,
  );

  // Group faces by new cluster index.
  const byCluster = new Map();
  for (const f of faces) {
    const c = assignment.get(f.id);
    if (!byCluster.has(c)) byCluster.set(c, []);
    byCluster.get(c).push(f);
  }

  // Carry a prior name/isMe forward by matching a new cluster's centroid to the
  // old people's representative descriptor (nearest, within threshold).
  const prevReps = prevPeople
    .filter((p) => Array.isArray(p.rep))
    .map((p) => ({ ...p }));

  const faceStore = tx(db, "faces", "readwrite");
  const peopleStore = tx(db, "people", "readwrite");
  // Clear old people rows (we rewrite them fresh).
  await reqToPromise(peopleStore.clear());

  let nextId = 1;
  for (const [, members] of byCluster) {
    const rep = centroid(members.map((m) => m.descriptor));
    let name = "";
    let isMe = false;
    let bestDist = Infinity;
    for (const prev of prevReps) {
      const dist = euclidean(rep, prev.rep);
      if (dist < bestDist && dist <= MATCH_THRESHOLD) {
        bestDist = dist;
        name = prev.name || "";
        isMe = !!prev.isMe;
      }
    }
    const personId = `p${nextId++}`;
    peopleStore.put({ id: personId, name, isMe, size: members.length, rep });
    for (const m of members) faceStore.put({ ...m, personId });
  }
}

/** All people (clusters), largest first: { id, name, isMe, size }. */
export async function listPeople() {
  const db = await openDb();
  if (!db) return [];
  const people = (await getAll(tx(db, "people", "readonly"))) || [];
  return people
    .map((p) => ({ id: p.id, name: p.name || "", isMe: !!p.isMe, size: p.size || 0 }))
    .sort((a, b) => b.size - a.size);
}

/** Name a person cluster. */
export async function namePerson(personId, name) {
  const db = await openDb();
  if (!db) return;
  const store = tx(db, "people", "readwrite");
  const p = await reqToPromise(store.get(personId));
  if (p) store.put({ ...p, name: String(name || "").slice(0, 40) });
}

/** Mark exactly one cluster as "me" (clears the flag on all others). */
export async function markMe(personId) {
  const db = await openDb();
  if (!db) return;
  const store = tx(db, "people", "readwrite");
  const all = (await getAll(store)) || [];
  for (const p of all) store.put({ ...p, isMe: p.id === personId });
}

export async function getMePersonId() {
  const people = await listPeople();
  return people.find((p) => p.isMe)?.id ?? null;
}

/** Photo ids that contain a given person (deduped, newest-first not guaranteed). */
export async function photoIdsForPerson(personId) {
  const db = await openDb();
  if (!db || !personId) return [];
  const idx = tx(db, "faces", "readonly").index("personId");
  const faces = (await reqToPromise(idx.getAll(personId))) || [];
  return [...new Set(faces.map((f) => f.photoId))];
}

/** Photo ids that contain "me" (empty until the user tags a cluster). */
export async function photoIdsForMe() {
  const me = await getMePersonId();
  return me ? photoIdsForPerson(me) : [];
}

/**
 * Resolve a free-text person reference to photo ids. "me"/"myself"/"i" → the
 * me cluster; otherwise a case-insensitive name match. Returns null when there's
 * no match (caller should fall back to normal ranking), [] when matched-but-empty.
 */
export async function photoIdsForQuery(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(me|myself|my ?self|of me|i)\b/.test(t)) {
    const me = await getMePersonId();
    if (me) return photoIdsForPerson(me);
  }
  const people = await listPeople();
  for (const p of people) {
    if (p.name && t.includes(p.name.toLowerCase())) return photoIdsForPerson(p.id);
  }
  return null;
}

/** For identity-locked generation: the photo ids (+ boxes) of the me cluster. */
export async function getMeReferences(limit = 6) {
  const db = await openDb();
  const me = await getMePersonId();
  if (!db || !me) return [];
  const idx = tx(db, "faces", "readonly").index("personId");
  const faces = (await reqToPromise(idx.getAll(me))) || [];
  // Prefer distinct photos (varied angles help identity fidelity).
  const seen = new Set();
  const out = [];
  for (const f of faces) {
    if (seen.has(f.photoId)) continue;
    seen.add(f.photoId);
    out.push({ photoId: f.photoId, box: f.box });
    if (out.length >= limit) break;
  }
  return out;
}

/** The "me" cluster's mean descriptor (its identity centroid), or null. */
export async function getMeCentroid() {
  const db = await openDb();
  if (!db) return null;
  const all = (await getAll(tx(db, "people", "readonly"))) || [];
  const me = all.find((p) => p.isMe);
  return Array.isArray(me?.rep) ? me.rep : null;
}

/**
 * How close is the face in a generated image to the user's real face? Returns
 * the euclidean distance from the best-matching detected face to the "me"
 * centroid (lower = more like the real user; < ~0.6 is "recognizably them"), or
 * null when there's no "me" tagged or no face detected. Used to auto-reroll
 * generations whose identity drifted.
 */
export async function faceDistanceToMe(bitmap) {
  const centroidVec = await getMeCentroid();
  if (!centroidVec) return null;
  const faces = await detectAndEmbed(bitmap);
  if (!faces.length) return null;
  let best = Infinity;
  for (const f of faces) {
    const d = euclidean(f.descriptor, centroidVec);
    if (d < best) best = d;
  }
  return best;
}

/** Is on-device identity verification usable (a "me" cluster exists)? */
export async function hasMeIdentity() {
  return (await getMeCentroid()) != null;
}

/** Wipe all face data (privacy control). */
export async function clearFaceData() {
  const db = await openDb();
  if (!db) return;
  await reqToPromise(tx(db, "faces", "readwrite").clear());
  await reqToPromise(tx(db, "people", "readwrite").clear());
  await reqToPromise(tx(db, "meta", "readwrite").clear());
}
