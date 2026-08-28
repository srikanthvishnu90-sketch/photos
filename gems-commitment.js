// gems-commitment.js — client boundary for the college commitment-post generator.
// searchSchools() reads the public directory (public.schools, public-read RLS);
// generateCommitment() sends the athlete photo + chosen school to the
// generate-commitment edge function. Degrades gracefully; never throws.
import { getSupabase, getSession } from "./gems-supabase.js";
import { getPhotoBlob } from "./gems-photolib.js";

const SUPABASE_URL = "https://hkwkxacvcgorhthwyslx.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Z8Fw1dZYiqOGUDITzU929A_i2k9wANc";
const FN_URL = `${SUPABASE_URL}/functions/v1/generate-commitment`;

// Friendly sport labels for the picker, keyed to the directory's sport codes.
export const SPORTS = Object.freeze([
  { code: "football", label: "Football" },
  { code: "mbb", label: "Basketball (M)" },
  { code: "wbb", label: "Basketball (W)" },
  { code: "baseball", label: "Baseball" },
  { code: "softball", label: "Softball" },
  { code: "msoc", label: "Soccer (M)" },
  { code: "wsoc", label: "Soccer (W)" },
  { code: "hockey", label: "Hockey" },
  { code: "wvb", label: "Volleyball" },
  { code: "lax", label: "Lacrosse" },
  { code: "golf", label: "Golf" },
  { code: "track", label: "Track" },
]);

export async function searchSchools(query) {
  try {
    const supabase = await getSupabase();
    if (!supabase) return [];
    const q = String(query || "").trim();
    if (q.length < 2) return [];
    const { data } = await supabase
      .from("schools")
      .select("id,display,mascot,color,alt_color,logo,sports")
      .ilike("display", `%${q}%`)
      .limit(10);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.info("searchSchools failed", error);
    return [];
  }
}

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

/**
 * Generate a commitment poster. Returns { url, ... } on success, or { error }.
 * @param {{photoId?:string, blob?:Blob, schoolId:string, sport?:string,
 *          athleteName?:string, headline?:string, quality?:string,
 *          requestId?:string}} opts
 */
export async function generateCommitment(opts) {
  try {
    const session = await getSession();
    if (!session) return { error: "signin" };
    // The free tier meters by REQUEST, not by image: every attempt at the same
    // poster shares one id (a likeness reroll must not read as a second
    // request). Callers that retry pass their own id; a lone call gets one here.
    let requestId = opts.requestId;
    if (!requestId) {
      try { requestId = crypto.randomUUID(); }
      catch { requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
    }
    let blob = opts.blob;
    if (!blob && opts.photoId) blob = await getPhotoBlob(opts.photoId);
    if (!blob) return { error: "nophoto" };
    const athleteBase64 = await blobToBase64(blob);
    // Extra identity references (the athlete's tagged face cluster) — more angles
    // of the SAME person → much stronger likeness in the poster.
    let athleteImages;
    const extraIds = Array.isArray(opts.identityPhotoIds)
      ? opts.identityPhotoIds.filter((id) => id && id !== opts.photoId).slice(0, 4)
      : [];
    if (extraIds.length) {
      const imgs = [];
      for (const id of extraIds) {
        try {
          const b = await getPhotoBlob(id);
          if (b) imgs.push(await blobToBase64(b));
        } catch (error) {
          console.info("identity ref skipped", error);
        }
      }
      if (imgs.length) athleteImages = imgs;
    }
    const res = await fetch(FN_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_PUBLISHABLE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        athleteBase64,
        athleteImages: athleteImages ?? undefined,
        mimeType: blob.type || "image/jpeg",
        schoolId: opts.schoolId,
        sport: opts.sport ?? null,
        athleteName: opts.athleteName ?? "",
        headline: opts.headline ?? "COMMITTED",
        quality: opts.quality ?? "pro",
        requestId,
      }),
    });
    const data = await res.json().catch(() => null);
    // The server's own code ("free_prompt_used" / "scene_cap_reached") rides
    // along as serverError, but `error` MUST stay "paywall" — spreading the body
    // over it put the server's code back and every caller's paywall branch
    // missed, so a hit paywall read as "that didn't generate — try again".
    if (res.status === 402) return { ...(data || {}), serverError: data?.error, error: "paywall" };
    if (data?.refused) return { error: "refused", reply: data.reply };
    if (!res.ok || !data?.url) return { error: data?.error || "failed" };
    return data;
  } catch (error) {
    console.info("generateCommitment failed", error);
    return { error: "failed" };
  }
}
