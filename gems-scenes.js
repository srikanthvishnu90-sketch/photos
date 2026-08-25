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
  { id: "dubai", label: "Dubai Luxe" },
  { id: "old-money", label: "Old Money" },
  { id: "boat", label: "On the Water" },
  { id: "dark-luxe", label: "Dark Luxe" },
  { id: "after-dark", label: "After Dark" },
]);

export const ASPECTS = Object.freeze([
  { id: "4:5", label: "Portrait" },
  { id: "1:1", label: "Square" },
  { id: "9:16", label: "Story" },
]);

// Pose + outfit option catalogs, per style pack. When a user picks a scene we
// surface a few candid poses and a few on-theme outfits as tappable chips, then
// pass the chosen `value` strings to generate-scene as `pose` / `wardrobe`.
// `value` is written as the phrase that slots into the prompt ("the user is …",
// "dress the user in …"). Keep them candid and phone-real, never posed-perfect.
const POSE_OPTIONS = Object.freeze({
  "old-money": [
    { label: "By a classic car", value: "leaning against a vintage sports car on a cobbled Monaco street, one hand in a pocket, looking off" },
    { label: "Walking the street", value: "walking mid-stride down a cobbled Belle-Époque street lined with palms, glancing off-camera" },
    { label: "Terrace overlook", value: "sitting on a hotel terrace overlooking the yacht harbor, relaxed, taking in the view" },
    { label: "At the balustrade", value: "standing at a stone balustrade looking out over the bay full of yachts, seen from behind and to the side" },
    { label: "Hand on watch", value: "standing on a palm-lined street adjusting the watch on their wrist, between-takes candid" },
  ],
  "euro-summer": [
    { label: "Walking a lane", value: "walking mid-stride down a narrow cobblestone alley, glancing off to the side, not at the camera" },
    { label: "Café table", value: "sitting at a marble café table with an espresso, leaning back relaxed, caught mid-conversation" },
    { label: "Leaning on a wall", value: "leaning against a sun-warmed stone wall with one hand in a pocket, looking out over the town" },
    { label: "On the steps", value: "sitting on worn stone steps with bougainvillea overhead, forearms on knees, looking away" },
    { label: "Overlooking the sea", value: "standing at a railing from behind over the shoulder, taking in the coastline and turquoise water" },
  ],
  dubai: [
    { label: "Infinity pool edge", value: "leaning on the edge of a rooftop infinity pool looking out at the skyline, water to the chest" },
    { label: "Rooftop lounge", value: "sitting back on a low cream sofa on a rooftop terrace at dusk, one arm along the back, relaxed" },
    { label: "At the glass", value: "standing at a floor-to-ceiling penthouse window looking down at the city, shot from behind and to the side" },
    { label: "Beach club daybed", value: "reclining on a striped beach-club daybed under an umbrella, sunglasses on, looking toward the water" },
    { label: "Walking the terrace", value: "walking across a marble terrace mid-stride, glancing off-camera, city behind" },
  ],
  boat: [
    { label: "Driving the boat", value: "at the wheel driving the boat, shot from behind over the shoulder, wake trailing behind" },
    { label: "On the bow", value: "sitting on the bow looking out at the coastline, one knee up, relaxed and candid" },
    { label: "Leaning on the rail", value: "leaning forearms on the chrome gunwale rail looking out over turquoise water" },
    { label: "Seated on deck", value: "sitting back on the teak deck taking in the view, relaxed, glancing off-camera" },
    { label: "Standing at the stern", value: "standing at the stern looking out over the wake, one hand on the rail, sunglasses on" },
  ],
  "dark-luxe": [
    { label: "By the window", value: "standing at a dark penthouse window against a blue-hour cityscape, lit by a single warm lamp, half in shadow" },
    { label: "On the sofa", value: "sitting low on a boucle sofa in a dim suite, one warm lamp glowing, looking off into the room" },
    { label: "At the pool", value: "standing at the edge of a dark infinity pool at dusk framed by deep-green foliage, seen from behind" },
    { label: "Espresso at the table", value: "leaning over a low travertine table with an espresso and a laptop, warm light on one side of the face" },
  ],
  "after-dark": [
    { label: "City at night", value: "standing on a balcony against a deep-navy night skyline, cool ambient light, hands in pockets" },
    { label: "Walking lit streets", value: "walking a dim city street at night past warm shop-lights, caught mid-stride, not looking at the camera" },
    { label: "Leaning, low light", value: "leaning against a wall under a single overhead light, deep protected shadows, quiet and candid" },
  ],
});

// Two go-to fits lead every pack (founder rec): a well-fitted linen button-down
// (long/short sleeve, color by location) with linen pants, or a tight good-fitting
// tee with good pants. Plus pack-appropriate alternates. No swimwear/shirtless.
const OUTFIT_OPTIONS = Object.freeze({
  "old-money": [
    { label: "Linen button-down", value: "a well-fitted linen or fine-cotton button-down in white, cream, pale blue or navy with tailored trousers and leather loafers" },
    { label: "Fitted tee & pants", value: "a tight, good-fitting plain tee or fine polo in white, navy or cream with sharp tailored trousers" },
    { label: "Navy blazer", value: "a navy blazer over a crisp white shirt with tailored cream trousers, understated old-money" },
    { label: "White shirt & trousers", value: "a tailored white shirt with cream wide-leg trousers and delicate gold jewelry" },
  ],
  "euro-summer": [
    { label: "Linen button-down", value: "a well-fitted linen button-down (long or short sleeve) in beige, white or olive with matching linen trousers and leather sandals" },
    { label: "Fitted tee & pants", value: "a tight, good-fitting plain tee in a warm neutral with well-fitted tailored trousers or clean chinos" },
    { label: "White halter set", value: "a white halter linen top with white wide-leg linen trousers, gold jewelry and a small leather bag" },
    { label: "Oversized white shirt", value: "an oversized white linen shirt with tailored white shorts and a slim brown belt" },
  ],
  dubai: [
    { label: "Crisp linen shirt", value: "a crisp well-fitted linen button-down in white, beige, light blue or navy with tailored trousers and a good watch" },
    { label: "Fitted tee & pants", value: "a tight, good-fitting plain tee in white, beige or navy with sharp tailored trousers" },
    { label: "Cream maxi dress", value: "a flowing cream maxi dress, elegant resort luxury" },
    { label: "White shirt & trousers", value: "a chic white shirt with tailored trousers, understated Gulf luxury" },
  ],
  boat: [
    { label: "Linen button-down", value: "a well-fitted linen button-down (long or short sleeve) in white, light blue or navy with white or stone linen trousers and sunglasses" },
    { label: "Fitted tee & pants", value: "a tight, good-fitting plain tee in white or navy with tailored linen trousers" },
    { label: "Striped linen shirt", value: "a white or striped linen shirt with tailored trousers, relaxed boat-day resortwear" },
    { label: "Cream sundress", value: "a breezy cream sundress with sunglasses, easy boat-day resortwear" },
  ],
  "dark-luxe": [
    { label: "Navy linen shirt", value: "a well-fitted linen or fine button-down in navy, black or charcoal with dark tailored trousers" },
    { label: "Fitted dark tee", value: "a tight, good-fitting plain tee in black, navy or charcoal with dark tailored trousers" },
    { label: "Suit, no tie", value: "a navy or charcoal suit with the collar open and no tie, relaxed penthouse formal" },
    { label: "Black slip dress", value: "an elegant black slip dress, quiet and expensive" },
  ],
  "after-dark": [
    { label: "Black button-down", value: "a well-fitted button-down in black or navy with dark trousers" },
    { label: "Fitted dark tee", value: "a tight, good-fitting plain tee in black or navy with dark tailored trousers" },
    { label: "Tee & overshirt", value: "a fitted tee under a matte black overshirt with dark trousers, sharp night-out" },
    { label: "Black slip dress", value: "a sleek black slip dress, understated night-out" },
  ],
});

/** Candid pose options for a style pack (or a small generic set). */
export function poseOptionsFor(stylePackId) {
  return POSE_OPTIONS[stylePackId] || [
    { label: "Walking", value: "walking mid-stride, glancing off-camera, candid" },
    { label: "Leaning", value: "leaning relaxed against a surface, looking out, not at the camera" },
    { label: "Seated", value: "sitting relaxed, caught mid-moment, natural expression" },
    { label: "From behind", value: "shot from behind over the shoulder, taking in the view" },
  ];
}

/** On-theme outfit options for a style pack (or a small generic set). */
export function outfitOptionsFor(stylePackId) {
  return OUTFIT_OPTIONS[stylePackId] || [
    { label: "White linen shirt", value: "a relaxed white linen button-down with tailored trousers" },
    { label: "Fitted tee", value: "a plain fitted white tee with dark jeans" },
    { label: "Knit polo", value: "a fitted knit polo with chinos and loafers" },
  ];
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
    let subjectImages;
    if (mode !== "background") {
      let blob = opts.subjectBlob;
      if (!blob && opts.subjectPhotoId) blob = await getPhotoBlob(opts.subjectPhotoId);
      if (blob) subjectBase64 = await blobToBase64(blob);
      // Extra identity references (the user's tagged face cluster) — more angles
      // of the SAME person → much stronger identity fidelity. Skip the primary.
      const extraIds = Array.isArray(opts.identityPhotoIds)
        ? opts.identityPhotoIds.filter((id) => id && id !== opts.subjectPhotoId).slice(0, 4)
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
        if (imgs.length) subjectImages = imgs;
      }
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
        subjectImages: subjectImages ?? undefined,
        aspect: opts.aspect ?? "4:5",
        quality: opts.quality ?? "standard",
        mode,
        matchReference: opts.matchReference === true,
        wardrobe: opts.wardrobe ?? undefined,
        pose: opts.pose ?? undefined,
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
