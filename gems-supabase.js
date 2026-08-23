// Single Supabase boundary for the Gems client.
// The publishable key is client-safe by design — every table is protected by
// owner-only RLS, so the key grants nothing beyond what policies allow.
// The client loads lazily from a CDN and every helper degrades to a silent
// no-op when offline or signed out, so the demo flow never breaks.

const SUPABASE_URL = "https://hkwkxacvcgorhthwyslx.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Z8Fw1dZYiqOGUDITzU929A_i2k9wANc";

let clientPromise = null;

export function getSupabase() {
  if (!clientPromise) {
    clientPromise = import(
      "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm"
    )
      .then(({ createClient }) =>
        createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY),
      )
      .catch((error) => {
        console.info("Supabase unavailable, continuing in demo mode", error);
        return null;
      });
  }
  return clientPromise;
}

export async function getSession() {
  const supabase = await getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session ?? null;
}

// Append-only behavioral pipeline (taste_events). Fire-and-forget: callers
// never await this, and it silently no-ops without a signed-in session.
export function recordTasteEvent(eventType, subject = {}) {
  void (async () => {
    try {
      const supabase = await getSupabase();
      if (!supabase) return;
      const session = await getSession();
      if (!session) return;
      await supabase.from("taste_events").insert({
        profile_id: session.user.id,
        event_type: eventType,
        subject,
      });
    } catch (error) {
      console.info("taste_event skipped", eventType, error);
    }
  })();
}
