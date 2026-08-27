// gems-scenes.js — client boundary for Scenes (photoreal "put me in a scene",
// e.g. Euro Summer). Uploads/lists the user's inspiration reference images and
// calls the generate-scene edge function. Degrades gracefully; never throws.
import { getSupabase, getSession } from "./gems-supabase.js";
import { getPhotoBlob } from "./gems-photolib.js";

const SUPABASE_URL = "https://hkwkxacvcgorhthwyslx.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Z8Fw1dZYiqOGUDITzU929A_i2k9wANc";
const FN_URL = `${SUPABASE_URL}/functions/v1/generate-scene`;

export const STYLE_PACKS = Object.freeze([
  { id: "dating", label: "Dating Profile" },
  { id: "euro-summer", label: "Euro Summer" },
  { id: "dubai", label: "Dubai Luxe" },
  { id: "old-money", label: "Old Money" },
  { id: "luxury-cars", label: "Luxury Cars" },
  { id: "beach-club", label: "Beach Club" },
  { id: "boat", label: "On the Water" },
  { id: "dark-luxe", label: "Dark Luxe" },
  { id: "after-dark", label: "After Dark" },
]);

// A dating profile is a VARIED SET (~6) — a mix of settings, framings and camera
// directions (looking at camera + away), stylish and fully clothed, like a real
// person's best photos. Each shot is generated SEPARATELY from its own recipe.
// Founder rule: a mix of everything, tailored to the person's real build.
export const DATING_SHOTS = Object.freeze([
  { label: "Driver's seat", prompt: "sitting in the driver's seat of a nice car in warm golden light, seatbelt on, glancing out the side window with a calm relaxed expression, city visible through the windscreen", pose: "sitting in the driver's seat looking out the window, one hand near the wheel, candid", wardrobe: "a fitted knit sweater or crewneck in navy or grey", aspect: "4:5" },
  { label: "Full-body outfit", prompt: "standing full-body on a plant-filled patio or terrace, relaxed with hands in pockets, looking straight at the camera, a stylish put-together outfit", pose: "standing full-body, hands loosely in pockets, weight on one leg, looking at the camera", wardrobe: "a crisp white or light linen shirt half-tucked with well-fitted jeans and clean sneakers", aspect: "4:5" },
  { label: "Golden-hour portrait", prompt: "a warm golden-hour half-body shot outdoors at dusk with soft sky behind, calm approachable expression looking straight at the camera", pose: "half-body, relaxed shoulders, looking softly at the camera, natural micro-smile", wardrobe: "a casual layered look — a plain tee under an open overshirt or light jacket", aspect: "4:5" },
  { label: "Street candid", prompt: "sitting on the step of a European street cafe or a stone stair, relaxed and looking off to the side, an effortless stylish streetwear fit, everyday city background", pose: "seated on a step, forearms on knees, looking off to the side, candid and unposed", wardrobe: "relaxed stylish streetwear — a sweatshirt or overshirt with loose jeans and clean shoes", aspect: "4:5" },
  { label: "Walking away", prompt: "walking down a sunlit city street glancing off to the side, mid-stride and candid, natural daylight, real urban background with some passers-by", pose: "walking mid-stride, glancing off to the side, not looking at the camera", wardrobe: "a smart-casual fit — a knit polo or button-down with tailored trousers", aspect: "4:5" },
  { label: "Rooftop social", prompt: "a relaxed half-body shot at a rooftop or nice interior with warm evening light and soft bokeh of people behind, an easy confident half-smile looking at the camera", pose: "half-body, relaxed, a slight genuine smile, looking at the camera, holding a drink", wardrobe: "an evening smart-casual look — a dark shirt or fine knit", aspect: "4:5" },
]);

/** The dating shot recipes (a fresh copy so callers can't mutate the frozen set). */
export function datingShots() {
  return DATING_SHOTS.map((s) => ({ ...s }));
}

export const ASPECTS = Object.freeze([
  { id: "4:5", label: "Portrait" },
  { id: "1:1", label: "Square" },
  { id: "9:16", label: "Story" },
]);

// Editing-style "templates" — the grades/looks we've built. When a user asks for
// several images, each one is rendered in a DIFFERENT editing style so they get a
// varied set to choose from and edit. Each `grade` is appended to the generation.
export const EDIT_STYLES = Object.freeze([
  { name: "Golden hour", grade: "warm golden-hour film grade — Kodak Portra warmth, soft lifted shadows, gentle grain" },
  { name: "After dark", grade: "moody low-key after-dark grade — underexposed, deep protected shadows, muted cool color" },
  { name: "Bright & airy", grade: "bright high-key clean grade — soft even light, gentle contrast, natural color" },
  { name: "Film warm", grade: "warm analog 35mm film grade — soft highlight rolloff, real grain, honey midtones" },
  { name: "Black & white", grade: "classic black-and-white film — rich tonal range, real grain, no color" },
  { name: "Cinematic", grade: "cinematic teal-and-orange grade — controlled contrast, filmic, protected skin" },
  { name: "Muted matte", grade: "muted matte grade — desaturated, soft faded shadows, understated" },
  { name: "Blue hour", grade: "cool blue-hour grade — steel-blue shadows, calm and moody, clean blacks" },
  { name: "Sun-kissed", grade: "warm sun-kissed grade — golden glow, gentle lens flare, sunny" },
  { name: "Editorial", grade: "clean editorial grade — natural true color, crisp and premium but realistic" },
]);

/** N editing styles (rotating through the catalog), for an N-image request. */
export function editStyles(n) {
  const list = EDIT_STYLES;
  return Array.from({ length: Math.max(1, n) }, (_, i) => list[i % list.length]);
}

// Pose + outfit option catalogs, per style pack. When a user picks a scene we
// surface a few candid poses and a few on-theme outfits as tappable chips, then
// pass the chosen `value` strings to generate-scene as `pose` / `wardrobe`.
// `value` is written as the phrase that slots into the prompt ("the user is …",
// "dress the user in …"). Keep them candid and phone-real, never posed-perfect.
const POSE_OPTIONS = Object.freeze({
  "beach-club": [
    { label: "On a day-bed", value: "reclining back on a teak day-bed under a striped umbrella, fully dressed in resortwear, sunglasses on, relaxed" },
    { label: "At the beach bar", value: "sitting at the beach bar with a cocktail, leaning on the counter, caught mid-conversation" },
    { label: "Walking the boardwalk", value: "walking along the wooden boardwalk toward the sand, glancing off-camera, breeze in the clothes" },
    { label: "By a cabana", value: "leaning against a white cabana post looking out at the turquoise water, one hand in a pocket" },
    { label: "At the water's edge", value: "standing at the water's edge fully dressed in resortwear, looking out to sea, seen from behind and to the side" },
  ],
  "luxury-cars": [
    { label: "Leaning on the hood", value: "leaning back against the hood of the supercar, arms loosely crossed, sunglasses on, looking off-camera" },
    { label: "Hand on the door", value: "standing beside the open driver's door with a hand resting on it, mid-motion about to get in" },
    { label: "In the driver's seat", value: "sitting in the driver's seat with one hand on the wheel, looking out through the windscreen, relaxed" },
    { label: "Walking to the car", value: "walking toward the parked supercar with the keys in hand, glancing off to the side, candid" },
    { label: "By the car (night)", value: "standing beside the car under warm street lights at night, one hand in a pocket, reflections sliding along the paint" },
  ],
  "old-money": [
    { label: "Crossing the hairpin", value: "walking across the Monaco Grand-Prix hairpin road with its red-and-white kerb, mid-stride, sunglasses on, glancing off-camera" },
    { label: "By a classic car (night)", value: "standing beside a classic cream convertible outside the lit Casino de Monte-Carlo at night, one hand in a pocket, relaxed" },
    { label: "Over the harbor", value: "leaning on a railing under a pine tree looking out over the Fontvieille harbor full of white yachts" },
    { label: "By a supercar", value: "standing beside a parked Ferrari on the Place du Casino, hand adjusting the watch, between-takes candid" },
    { label: "At the iron gate", value: "standing at an ornate iron gate framing the sea and green mountains, seen from behind, hand in pocket" },
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
  "beach-club": [
    { label: "Open linen shirt", value: "an open buttoned white or blue linen shirt with linen shorts and leather sandals, sunglasses" },
    { label: "Polo & shorts", value: "a fitted white or navy polo with tailored linen shorts" },
    { label: "Sundress", value: "a breezy cream or floral sundress with sunglasses and a straw hat" },
    { label: "Linen cover-up", value: "a linen shirt-dress or co-ord cover-up worn over the outfit, chic and modest" },
  ],
  "luxury-cars": [
    { label: "Black tee & pants", value: "a fitted black tee with sharp tailored trousers, a good watch and sunglasses" },
    { label: "White linen shirt", value: "a crisp white linen shirt with tailored stone trousers and loafers" },
    { label: "Navy polo", value: "a fitted navy polo with grey tailored trousers and sunglasses" },
    { label: "Light bomber", value: "a fitted light bomber jacket over a plain tee with dark tailored trousers" },
  ],
  "old-money": [
    { label: "Blue shirt & white trousers", value: "a pale-blue linen shirt with white wide-leg pleated trousers, leather loafers, a good watch and sunglasses — the signature Monaco look" },
    { label: "Black shirt (night)", value: "a black silky shirt with white pleated trousers, elegant and cinematic for a Monaco evening" },
    { label: "Blue polo & grey trousers", value: "a fitted pale-blue polo with grey tailored trousers, a watch and sunglasses" },
    { label: "Navy blazer", value: "a navy blazer over a crisp white shirt with tailored cream trousers, understated old-money" },
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

// "Which kind of photo?" setting options for the quick questionnaire, per pack.
// Each value slots straight into the generation prompt as the scene.
const SETTING_OPTIONS = Object.freeze({
  "euro-summer": [
    { label: "Amalfi cliffside", value: "on an Amalfi/Positano cliffside terrace above a turquoise sea at golden hour, bougainvillea cascading nearby" },
    { label: "Cinque Terre alley", value: "in a narrow Cinque Terre alley of colorful stacked houses perched over clear teal water" },
    { label: "Lemon café", value: "at a lemon-draped Capri café terrace with marble bistro tables and iron lanterns" },
    { label: "Cobblestone street", value: "on a cobblestone alley of ochre and butter-yellow buildings with green shutters, geraniums in terracotta pots" },
    { label: "Riviera cove", value: "at a French-Riviera cove with cypress trees, honey-stone houses and moored wooden boats" },
    { label: "Seaside steps", value: "on worn stone steps down to a Mediterranean harbor, whitewashed walls and blue shutters around" },
  ],
  dubai: [
    { label: "Infinity pool", value: "at a rooftop infinity pool at blue-hour overlooking the Burj Khalifa and the lit Downtown skyline" },
    { label: "Penthouse window", value: "in a marble penthouse living room with a floor-to-ceiling window framing the Burj Khalifa at dusk" },
    { label: "Beach club", value: "at a chic beach club with striped umbrellas and day-beds on raked sand, calm Gulf water" },
    { label: "Rooftop terrace", value: "on a golden-hour rooftop terrace with a low cream sofa overlooking Dubai Marina and the sea" },
  ],
  "old-money": [
    { label: "Place du Casino", value: "on the Place du Casino outside the Belle-Époque Casino de Monte-Carlo with parked supercars" },
    { label: "Grand-Prix hairpin", value: "crossing the Monaco Grand-Prix hairpin road by the Fairmont with its red-and-white kerb" },
    { label: "Belle-Époque street", value: "on a cobbled Belle-Époque Monaco street with cream facades, red-and-white flags and palms" },
    { label: "Over the harbor", value: "at a railing under a pine tree looking over the Fontvieille harbor full of white yachts" },
  ],
  "luxury-cars": [
    { label: "Hotel forecourt", value: "beside a gleaming supercar at the valet forecourt of a grand Belle-Époque hotel" },
    { label: "Cobbled street", value: "beside a parked supercar on a cobbled European street at golden hour" },
    { label: "In the driver's seat", value: "sitting in the driver's seat of a supercar with a hand on the wheel" },
    { label: "Night garage", value: "beside the car under warm garage/street lights at night, reflections on the paint" },
  ],
  "beach-club": [
    { label: "Striped day-bed", value: "on a teak day-bed under a striped umbrella on raked white sand by turquoise water" },
    { label: "Beach bar", value: "at a beachfront pool bar with rattan stools and a cocktail, turquoise water beyond" },
    { label: "Cabana", value: "at a shaded white cabana with billowing curtains, palms and calm sea beyond" },
    { label: "Boardwalk", value: "walking a wooden boardwalk toward the sand, striped parasols and boats in the distance" },
  ],
  boat: [
    { label: "Driving the boat", value: "at the wheel of a day-yacht on clear turquoise water, a bright wake trailing behind" },
    { label: "On the bow", value: "sitting on the bow of a boat looking out at a Greek/Italian coastline over teal water" },
    { label: "At the stern", value: "at the teak stern of a yacht over sparkling deep-blue water, coastline in the distance" },
  ],
});

/** "Which kind of photo?" options for a pack (empty if the pack has no set). */
export function settingOptionsFor(stylePackId) {
  return SETTING_OPTIONS[stylePackId] || [];
}

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
    // The server requires a requestId to meter the free tier (no id → 402), so
    // every caller gets one even if it didn't pass its own batch id.
    let requestId = opts.requestId;
    if (!requestId) {
      try { requestId = crypto.randomUUID(); }
      catch { requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
    }
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
        build: opts.build ?? undefined,
        requestId,
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
