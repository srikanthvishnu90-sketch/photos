// Moodboard persistence for the Gems client.
// Sits behind the single Supabase boundary in gems-supabase.js: every helper
// degrades to a silent no-op (null / { saved: false } / {}) when offline or
// signed out, so the demo flow never breaks and callers never see a throw.

import { getSupabase, getSession, recordTasteEvent } from "./gems-supabase.js";

// Returns { id, name } of the user's default moodboard project, creating it
// on first use. Returns null when signed out or offline.
export async function getMoodboardProject() {
  try {
    const supabase = await getSupabase();
    if (!supabase) return null;
    const session = await getSession();
    if (!session) return null;

    const { data: existing, error: selectError } = await supabase
      .from("projects")
      .select("id, name")
      .eq("profile_id", session.user.id)
      .eq("kind", "moodboard")
      .order("created_at", { ascending: false })
      .limit(1);
    if (selectError) throw selectError;
    if (existing && existing.length > 0) {
      return { id: existing[0].id, name: existing[0].name };
    }

    const { data: created, error: insertError } = await supabase
      .from("projects")
      .insert({
        profile_id: session.user.id,
        kind: "moodboard",
        name: "Moodboard",
      })
      .select()
      .single();
    if (insertError) throw insertError;
    if (!created) return null;
    return { id: created.id, name: created.name };
  } catch (error) {
    console.info("moodboard unavailable, continuing in demo mode", error);
    return null;
  }
}

// Saves a Discover card into the default moodboard.
// Returns { saved: boolean, duplicate?: boolean }; never throws.
export async function saveCardToMoodboard(card) {
  try {
    const project = await getMoodboardProject();
    if (!project) return { saved: false };

    const supabase = await getSupabase();
    if (!supabase) return { saved: false };
    const session = await getSession();
    if (!session) return { saved: false };

    const assetLocalId = `discover:${card.id}`;

    const { data: existing, error: selectError } = await supabase
      .from("project_photos")
      .select("id")
      .eq("project_id", project.id)
      .eq("asset_local_id", assetLocalId)
      .limit(1);
    if (selectError) throw selectError;
    if (existing && existing.length > 0) {
      return { saved: false, duplicate: true };
    }

    const { error: insertError } = await supabase.from("project_photos").insert({
      project_id: project.id,
      profile_id: session.user.id,
      asset_local_id: assetLocalId,
      ai_selected: false,
      derived: {
        source: "discover",
        title: card.title,
        credit: card.credit,
        scene: card.scene,
        categories: card.categories,
      },
    });
    if (insertError) throw insertError;

    recordTasteEvent("moodboard_saved", { cardId: card.id, title: card.title });
    return { saved: true };
  } catch (error) {
    console.info("moodboard save skipped, continuing in demo mode", error);
    return { saved: false };
  }
}

// Returns a plain object mapping moodboard project id -> saved item count for
// the signed-in user's moodboard projects. Empty object when signed out.
export async function fetchMoodboardCounts() {
  try {
    const supabase = await getSupabase();
    if (!supabase) return {};
    const session = await getSession();
    if (!session) return {};

    const { data: boards, error: boardsError } = await supabase
      .from("projects")
      .select("id")
      .eq("profile_id", session.user.id)
      .eq("kind", "moodboard");
    if (boardsError) throw boardsError;
    if (!boards || boards.length === 0) return {};

    const boardIds = boards.map((board) => board.id);
    const { data: photos, error: photosError } = await supabase
      .from("project_photos")
      .select("project_id")
      .in("project_id", boardIds)
      .limit(1000);
    if (photosError) throw photosError;

    const counts = {};
    boardIds.forEach((id) => {
      counts[id] = 0;
    });
    (photos ?? []).forEach((photo) => {
      counts[photo.project_id] = (counts[photo.project_id] ?? 0) + 1;
    });
    return counts;
  } catch (error) {
    console.info("moodboard counts unavailable, continuing in demo mode", error);
    return {};
  }
}
