// gems-chat-context.js — builds the on-device GROUNDING the chat orchestrator
// needs to stop being blind. The intelligence (library, faces, embeddings, taste)
// all lives on-device, so the CLIENT does the retrieval and hands the edge
// function a compact context: a library summary, the photos relevant to THIS
// message (via semantic search / face lookup), and the user's taste. Nothing but
// small text + photo ids/captions is sent — never pixels. Never throws.
import { listPhotos } from "./gems-photolib.js";
import { listPeople, photoIdsForQuery } from "./gems-faces.js";
import { searchPhotos, indexedCount } from "./gems-embeddings.js";
import { fetchUserAesthetics, fetchTasteSummary } from "./gems-ranker.js";

// ---- Pure formatters (unit-tested) ---------------------------------------

/** One short human phrase describing a Pass-A caption object. */
export function summarizePassA(passA = {}) {
  const parts = [];
  if (passA.photo_type && passA.photo_type !== "photo") parts.push(String(passA.photo_type));
  const n = Number(passA.people_count);
  if (Number.isFinite(n) && n > 0) parts.push(n === 1 ? "1 person" : `${n} people`);
  if (passA.smile === true || passA.smile === "yes") parts.push("smiling");
  if (passA.emotion && passA.emotion !== "neutral") parts.push(String(passA.emotion));
  const tags = Array.isArray(passA.vibe_tags) ? passA.vibe_tags.slice(0, 3) : [];
  if (tags.length) parts.push(tags.join(", "));
  return parts.join(" · ").slice(0, 100) || "a photo";
}

/** Compact library summary string for the prompt. */
export function formatLibrary(library) {
  if (!library || !library.count) return "The camera roll is empty.";
  const bits = [`${library.count} photos`];
  if (library.dateRange?.from && library.dateRange?.to) {
    const f = new Date(library.dateRange.from).toISOString().slice(0, 10);
    const t = new Date(library.dateRange.to).toISOString().slice(0, 10);
    bits.push(`from ${f} to ${t}`);
  }
  if (library.indexed) bits.push(`${library.indexed} searchable`);
  const named = (library.people || []).filter((p) => p.name || p.isMe);
  if (named.length) {
    bits.push(
      "people: " +
        named.map((p) => `${p.isMe ? "You" : p.name} (${p.count})`).join(", "),
    );
  }
  return bits.join(" · ");
}

// ---- Context builder (IO) -------------------------------------------------

/**
 * Assemble the chat grounding for a message. Returns
 * { library, relevantPhotos:[{id,caption}], relevantUrls:Map, taste }.
 * relevantUrls is kept client-side (for rendering thumbnails); only ids +
 * captions are meant to go to the server.
 */
export async function buildChatContext(message) {
  const out = { library: null, relevantPhotos: [], relevantUrls: new Map(), taste: null };
  let photos = [];
  try {
    photos = await listPhotos();
  } catch {
    photos = [];
  }

  // ---- Library summary
  try {
    let minDate = Infinity;
    let maxDate = -Infinity;
    for (const p of photos) {
      const t = p.addedAt || 0;
      if (t) {
        if (t < minDate) minDate = t;
        if (t > maxDate) maxDate = t;
      }
    }
    let people = [];
    try {
      people = (await listPeople()).slice(0, 8).map((pp) => ({
        name: pp.name || "",
        isMe: !!pp.isMe,
        count: pp.size || 0,
      }));
    } catch {
      people = [];
    }
    let indexed = 0;
    try {
      indexed = await indexedCount();
    } catch {
      indexed = 0;
    }
    out.library = {
      count: photos.length,
      dateRange: photos.length && minDate !== Infinity ? { from: minDate, to: maxDate } : null,
      people,
      indexed,
    };
  } catch (error) {
    console.info("library summary skipped", error);
  }

  // ---- Photos relevant to THIS message: person filter, else semantic search.
  try {
    const idToPhoto = new Map(photos.map((p) => [p.id, p]));
    let ids = null;
    try {
      ids = await photoIdsForQuery(message); // "of me" / "of <name>"
    } catch {
      ids = null;
    }
    if (!ids || !ids.length) {
      try {
        const sem = await searchPhotos(message, 8);
        if (sem && sem.length) ids = sem.map((s) => s.photoId);
      } catch {
        /* no index */
      }
    }
    if (ids && ids.length) {
      for (const id of ids.slice(0, 8)) {
        const p = idToPhoto.get(id);
        if (!p) continue;
        out.relevantPhotos.push({ id, caption: summarizePassA(p.derived?.passA || {}) });
        if (p.url) out.relevantUrls.set(id, p.url);
      }
    }
  } catch (error) {
    console.info("relevant photos skipped", error);
  }

  // ---- Taste (read behavior back into context — the missing personalization).
  try {
    const [aesthetics, summary] = await Promise.all([
      fetchUserAesthetics().catch(() => []),
      fetchTasteSummary().catch(() => null),
    ]);
    out.taste = { aesthetics: aesthetics || [], summary: summary || null };
  } catch (error) {
    console.info("taste context skipped", error);
  }

  return out;
}

/** The server-safe slice of a context (no urls/pixels). */
export function serverContext(ctx) {
  return {
    library: ctx?.library ?? null,
    relevantPhotos: Array.isArray(ctx?.relevantPhotos) ? ctx.relevantPhotos.slice(0, 8) : [],
    taste: ctx?.taste ?? null,
  };
}
