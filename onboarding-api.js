// Wired to Supabase (project: gems). Every write requires a signed-in
// session and silently falls back to demo mode without one, so the
// onboarding UI is identical either way.
import { getSupabase, getSession, recordTasteEvent } from "./gems-supabase.js";

/**
 * @typedef {"female" | "male" | "unspecified" | null} GenderValue
 * @typedef {"Under 18" | "18–21" | "22–29" | "30+" | null} AgeRange
 * @typedef {Object} OnboardingState
 * @property {string} name
 * @property {GenderValue} gender
 * @property {AgeRange} ageRange
 * @property {string[]} aesthetics
 */

const AGE_RANGE_DB = Object.freeze({
  "Under 18": "under_18",
  "18–21": "18_21",
  "22–29": "22_29",
  "30+": "30_plus",
});

/**
 * @param {OnboardingState} state
 * @returns {Promise<{ok: true}>}
 */
export async function submitOnboarding(state) {
  try {
    const supabase = await getSupabase();
    const session = await getSession();
    if (!supabase || !session) {
      console.info("Onboarding kept local (no session)", state);
      return { ok: true };
    }
    const profileId = session.user.id;

    // Minors policy: under-18 profiles never store gender server-side.
    const isMinor = state.ageRange === "Under 18";
    await supabase.from("profiles").upsert({
      id: profileId,
      display_name: state.name.trim() || "New user",
      gender: isMinor ? null : (state.gender ?? null),
      age_range: AGE_RANGE_DB[state.ageRange] ?? null,
    });

    // Consent rows exist from day one, both opt-ins default-off.
    await supabase
      .from("consents")
      .upsert({ profile_id: profileId }, { ignoreDuplicates: true });

    if (state.aesthetics.length) {
      await supabase.from("profile_aesthetics").upsert(
        state.aesthetics.map((label, position) => ({
          profile_id: profileId,
          label,
          position,
        })),
        { onConflict: "profile_id,label", ignoreDuplicates: true },
      );
    }

    recordTasteEvent("onboarding_completed", {
      aesthetics: state.aesthetics,
    });
  } catch (error) {
    console.info("Onboarding submit failed, kept local", error);
  }
  return { ok: true };
}

/**
 * @param {string} rawText
 * @param {GenderValue} gender
 * @param {AgeRange} ageRange
 * @param {string[]} currentSelections
 */
export function logCustomAesthetic(rawText, gender, ageRange, currentSelections) {
  // Minors policy: never ship free-text + demographics to analytics for
  // under-18 accounts.
  if (ageRange === "Under 18") return;
  void (async () => {
    try {
      const supabase = await getSupabase();
      const session = await getSession();
      if (!supabase || !session) return;
      await supabase.from("custom_aesthetic_events").insert({
        profile_id: session.user.id,
        raw_text: rawText,
        gender: gender ?? null,
        age_range: AGE_RANGE_DB[ageRange] ?? null,
        co_selections: currentSelections,
      });
    } catch (error) {
      console.info("custom aesthetic event skipped", error);
    }
  })();
}
