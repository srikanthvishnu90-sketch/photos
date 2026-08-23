// Privacy + data-control client boundary (Master Features #29).
// Everything here is best-effort and NEVER throws: signed out, offline, or a
// server error degrades to a null / false / { error } result the caller can
// render honestly. Browser-only APIs (Blob, fetch) are touched solely inside
// function bodies so importing this module in Node stays safe.
import { getSupabase, getSession, recordTasteEvent } from "./gems-supabase.js";

// Keep in sync with gems-supabase.js, which declares these but does not export
// them (client-safe by design — owner-only RLS is the real gatekeeper).
const SUPABASE_URL = "https://hkwkxacvcgorhthwyslx.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Z8Fw1dZYiqOGUDITzU929A_i2k9wANc";

const DELETE_ENDPOINT = `${SUPABASE_URL}/functions/v1/delete-account`;

// The only two consent flags — both default-off, both explicit (schema v1).
const CONSENT_KEYS = Object.freeze(["training_opt_in", "discover_feature_opt_in"]);
const DEFAULT_CONSENTS = Object.freeze({
  training_opt_in: false,
  discover_feature_opt_in: false,
});

// Read the caller's own consents row.
//   null              → signed out (no session)
//   { false, false }  → session exists but no row yet, or a read hiccup
//   { …, … }          → the stored flags
export async function getConsents() {
  try {
    const supabase = await getSupabase();
    const session = await getSession();
    if (!supabase || !session) return null;
    const { data, error } = await supabase
      .from("consents")
      .select("training_opt_in, discover_feature_opt_in")
      .eq("profile_id", session.user.id)
      .maybeSingle();
    if (error || !data) return { ...DEFAULT_CONSENTS };
    return {
      training_opt_in: Boolean(data.training_opt_in),
      discover_feature_opt_in: Boolean(data.discover_feature_opt_in),
    };
  } catch (error) {
    console.info("getConsents skipped", error);
    return null;
  }
}

// Upsert one consent flag for the caller. Returns whether it persisted.
export async function setConsent(key, value) {
  try {
    if (!CONSENT_KEYS.includes(key)) return false;
    const supabase = await getSupabase();
    const session = await getSession();
    if (!supabase || !session) return false;
    const next = Boolean(value);
    const { error } = await supabase.from("consents").upsert(
      {
        profile_id: session.user.id,
        [key]: next,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "profile_id" },
    );
    if (error) {
      console.info("setConsent write failed", key, error);
      return false;
    }
    recordTasteEvent("consent_changed", { key, value: next });
    return true;
  } catch (error) {
    console.info("setConsent skipped", key, error);
    return false;
  }
}

// Data portability: assemble the rows Gems keeps about the caller into a
// downloadable JSON Blob. Best-effort; null when signed out or Blob is
// unavailable (e.g. imported in Node). Original photos are NOT included here —
// they never left the device, so there is nothing server-side to export.
export async function exportMyData() {
  try {
    const supabase = await getSupabase();
    const session = await getSession();
    if (!supabase || !session) return null;
    if (typeof Blob === "undefined") return null;
    const uid = session.user.id;

    const [profile, consents, aesthetics, projects, tasteCount] = await Promise.all([
      supabase.from("profiles").select("*").eq("id", uid).maybeSingle(),
      supabase.from("consents").select("*").eq("profile_id", uid).maybeSingle(),
      supabase
        .from("profile_aesthetics")
        .select("*")
        .eq("profile_id", uid)
        .order("position"),
      supabase
        .from("projects")
        .select("*")
        .eq("profile_id", uid)
        .order("updated_at", { ascending: false }),
      supabase
        .from("taste_events")
        .select("id", { count: "exact", head: true })
        .eq("profile_id", uid),
    ]);

    const payload = {
      export: "your Gems data",
      exported_at: new Date().toISOString(),
      account_id: uid,
      note:
        "This is everything Gems keeps about you. Your original photos are not " +
        "here — they never left your device. Only 512px thumbnails and images " +
        "you explicitly edited are ever sent, and edited outputs are the only " +
        "pixels stored server-side.",
      profile: profile?.data ?? null,
      consents: consents?.data ?? { ...DEFAULT_CONSENTS },
      profile_aesthetics: aesthetics?.data ?? [],
      projects: projects?.data ?? [],
      taste_events_count: tasteCount?.count ?? 0,
    };

    return new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
  } catch (error) {
    console.info("exportMyData skipped", error);
    return null;
  }
}

// Irreversibly delete the caller's account + all their data via the
// delete-account edge function, then sign out locally on success.
//   { deleted: true } → gone; the session has been cleared
//   { error }         → nothing was deleted (or a partial failure the fn reports)
export async function deleteMyAccount() {
  try {
    const supabase = await getSupabase();
    const session = await getSession();
    if (!supabase || !session) return { error: "signed_out" };

    const response = await fetch(DELETE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_PUBLISHABLE_KEY,
      },
      body: JSON.stringify({ confirm: true }),
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok || !data?.deleted) {
      return { error: data?.error || `delete failed: HTTP ${response.status}` };
    }

    // Clear the local session so the app can't act as a ghost of a deleted
    // account. Best-effort — the server truth is already committed.
    try {
      await supabase.auth.signOut();
    } catch (error) {
      console.info("Sign-out after delete finished locally", error);
    }
    return { deleted: true };
  } catch (error) {
    console.info("deleteMyAccount failed", error);
    return { error: "network_error" };
  }
}
