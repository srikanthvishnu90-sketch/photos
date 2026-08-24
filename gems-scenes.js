// gems-scenes.js — client boundary for Scenes (photoreal "put me in a scene",
// e.g. Euro Summer). Uploads/lists the user's inspiration reference images and
// calls the generate-scene edge function. Degrades gracefully; never throws.
import { getSupabase, getSession } from "./gems-supabase.js";
import { getPhotoBlob } from "./gems-photolib.js";

const SUPABASE_URL = "https://hkwkxacvcgorhthwyslx.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Z8Fw1dZYiqOGUDITzU929A_i2k9wANc";
const FN_URL = `${SUPABASE_URL}/functions/v1/generate-scene`;

export const STYLE_PACKS = Object.freeze([
  { id: "euro-summer", label: "Euro Summer" },
  { id: "dark-luxe", label: "Dark Luxe" },
  { id: "after-dark", label: "After Dark" },
]);

export const ASPECTS = Object.freeze([
  { id: "4:5", label: "Portrait" },
  { id: "1:1", label: "Square" },
  { id: "9:16", label: "Story" },
]);

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

function uuid() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  }
}

/** Upload an inspiration reference image (owner-scoped). Returns {id} or {error}. */
export async function uploadInspiration(file, label = "") {
  try {
    const session = await getSession();
    if (!session) return { error: "signin" };
    const supabase = await getSupabase();
    if (!supabase) return { error: "offline" };
    const ext = (file.type || "").includes("png") ? "png" : "jpg";
    const path = `${session.user.id}/${uuid()}.${ext}`;
    const up = await supabase.storage.from("inspiration").upload(path, file, { contentType: file.type || "image/jpeg" });
    if (up.error) return { error: up.error.message };
    const { data } = await supabase
      .from("inspiration_assets")
      .insert({ profile_id: session.user.id, storage_path: path, label })
      .select("id, storage_path, label")
      .maybeSingle();
    return data ?? { error: "insert_failed" };
  } catch (error) {
    console.info("uploadInspiration failed", error);
    return { error: "failed" };
  }
}

/** List the user's inspiration images with short-lived signed preview URLs. */
export async function listInspiration() {
  try {
    const supabase = await getSupabase();
    const session = await getSession();
    if (!supabase || !session) return [];
    const { data } = await supabase
      .from("inspiration_assets")
      .select("id, storage_path, label, created_at")
      .order("created_at", { ascending: false })
      .limit(40);
    const rows = data ?? [];
    const withUrls = await Promise.all(
      rows.map(async (r) => {
        const { data: signed } = await supabase.storage.from("inspiration").createSignedUrl(r.storage_path, 3600);
        return { ...r, url: signed?.signedUrl ?? null };
      }),
    );
    return withUrls;
  } catch (error) {
    console.info("listInspiration failed", error);
    return [];
  }
}

export async function deleteInspiration(id, storagePath) {
  try {
    const supabase = await getSupabase();
    if (!supabase) return;
    await supabase.from("inspiration_assets").delete().eq("id", id);
    if (storagePath) await supabase.storage.from("inspiration").remove([storagePath]);
  } catch (error) {
    console.info("deleteInspiration failed", error);
  }
}

/**
 * Generate a scene. opts: { subjectPhotoId?, subjectBlob?, prompt, stylePackId?,
 * referenceAssetIds?, aspect?, quality?, mode?, matchReference?, wardrobe? }.
 *   mode: "me" (put the user in the scene, default) | "background" (empty scene).
 *   matchReference: recreate the selected reference photo AS the user (face swap).
 *   wardrobe: optional outfit to dress the user in.
 * Returns { url, ... } or { error }.
 */
export async function generateScene(opts) {
  try {
    const session = await getSession();
    if (!session) return { error: "signin" };
    const mode = opts.mode === "background" ? "background" : "me";
    let subjectBase64;
    if (mode !== "background") {
      let blob = opts.subjectBlob;
      if (!blob && opts.subjectPhotoId) blob = await getPhotoBlob(opts.subjectPhotoId);
      if (blob) subjectBase64 = await blobToBase64(blob);
    }
    const res = await fetch(FN_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_PUBLISHABLE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: opts.prompt || "a photo of me",
        stylePackId: opts.stylePackId ?? null,
        referenceAssetIds: Array.isArray(opts.referenceAssetIds) ? opts.referenceAssetIds.slice(0, 3) : [],
        subjectBase64: subjectBase64 ?? undefined,
        aspect: opts.aspect ?? "4:5",
        quality: opts.quality ?? "standard",
        mode,
        matchReference: opts.matchReference === true,
        wardrobe: opts.wardrobe ?? undefined,
      }),
    });
    const data = await res.json().catch(() => null);
    if (res.status === 402) return { error: "paywall", ...(data || {}) };
    if (data?.refused) return { error: "refused", reply: data.reply };
    if (!res.ok || !data?.url) return { error: data?.error || "failed" };
    return data;
  } catch (error) {
    console.info("generateScene failed", error);
    return { error: "failed" };
  }
}
