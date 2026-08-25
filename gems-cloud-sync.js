// gems-cloud-sync.js — per-account backend sync for imported photos.
//
// (b) IMPORT LEDGER: every import is recorded in public.photo_imports (RLS: a
//     user only ever sees their own rows), so the backend knows what each account
//     imported — metadata only, usable for features across devices.
// (c) PHOTO SYNC: the pixels are uploaded to a PRIVATE, owner-scoped Storage
//     bucket ('photos', path <userId>/<photoId>.<ext>), so a user's library
//     follows them to any device. On a fresh device we hydrate from here.
//
// NOTE: this deliberately changes the old "photos never leave the device" model —
// photos now sync to the user's OWN private backend space (RLS-locked to them).
// Everything here is best-effort and never throws: if offline or signed out, the
// on-device library still works exactly as before.
import { getSupabase, getSession } from "./gems-supabase.js";

const BUCKET = "photos";

function extFor(type) {
  const t = String(type || "").toLowerCase();
  if (t.includes("png")) return "png";
  if (t.includes("webp")) return "webp";
  if (t.includes("heic") || t.includes("heif")) return "heic";
  return "jpg";
}

function metaOf(record) {
  return {
    name: record.name ?? null,
    type: record.type ?? null,
    width: record.width ?? null,
    height: record.height ?? null,
    addedAt: record.addedAt ?? null,
    metrics: record.metrics ?? null,
    derived: record.derived ?? null,
  };
}

/** Upload one record's pixels to Storage + upsert its ledger row. Best-effort. */
export async function uploadRecord(record) {
  try {
    if (!record?.id) return false;
    const session = await getSession();
    if (!session) return false;
    const supabase = await getSupabase();
    if (!supabase) return false;
    const uid = session.user.id;
    let storagePath = null;
    if (record.blob) {
      const path = `${uid}/${record.id}.${extFor(record.type)}`;
      const up = await supabase.storage
        .from(BUCKET)
        .upload(path, record.blob, { contentType: record.type || "image/jpeg", upsert: true });
      if (!up.error) storagePath = path;
      else console.info("cloud photo upload failed", up.error.message);
    }
    const { error } = await supabase.from("photo_imports").upsert(
      { profile_id: uid, photo_id: record.id, storage_path: storagePath, meta: metaOf(record) },
      { onConflict: "profile_id,photo_id" },
    );
    if (error) {
      console.info("import ledger upsert failed", error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.info("uploadRecord failed", error);
    return false;
  }
}

/** Upload many records sequentially in the background (gentle on the network). */
export async function uploadRecords(records) {
  const list = Array.isArray(records) ? records : [];
  let n = 0;
  for (const r of list) {
    // eslint-disable-next-line no-await-in-loop
    if (await uploadRecord(r)) n += 1;
  }
  return n;
}

/** The account's import ledger rows (metadata + storage paths). */
export async function listCloudMeta() {
  try {
    const session = await getSession();
    if (!session) return [];
    const supabase = await getSupabase();
    if (!supabase) return [];
    const { data } = await supabase
      .from("photo_imports")
      .select("photo_id, storage_path, meta, created_at")
      .eq("profile_id", session.user.id)
      .order("created_at", { ascending: false });
    return data ?? [];
  } catch (error) {
    console.info("listCloudMeta failed", error);
    return [];
  }
}

/** Download the pixels for a stored photo. Returns a Blob or null. */
export async function downloadBlob(storagePath) {
  try {
    if (!storagePath) return null;
    const supabase = await getSupabase();
    if (!supabase) return null;
    const { data } = await supabase.storage.from(BUCKET).download(storagePath);
    return data ?? null;
  } catch (error) {
    console.info("downloadBlob failed", error);
    return null;
  }
}

/** Remove a photo from the backend (ledger row + stored pixels). Best-effort. */
export async function deleteCloud(photoId) {
  try {
    if (!photoId) return;
    const session = await getSession();
    if (!session) return;
    const supabase = await getSupabase();
    if (!supabase) return;
    const uid = session.user.id;
    const { data: row } = await supabase
      .from("photo_imports")
      .select("storage_path")
      .eq("profile_id", uid)
      .eq("photo_id", photoId)
      .maybeSingle();
    if (row?.storage_path) {
      try { await supabase.storage.from(BUCKET).remove([row.storage_path]); } catch { /* ignore */ }
    }
    await supabase.from("photo_imports").delete().eq("profile_id", uid).eq("photo_id", photoId);
  } catch (error) {
    console.info("deleteCloud failed", error);
  }
}
