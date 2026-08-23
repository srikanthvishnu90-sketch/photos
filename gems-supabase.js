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
        createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
          auth: {
            // Persist the session and finish the OAuth (PKCE) code exchange on
            // the return trip so a Google sign-in resolves without a reset.
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
            flowType: "pkce",
          },
        }),
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

// Wait for a session to exist — used on an OAuth return, where the URL code
// exchange finishes a beat after boot. Resolves immediately if a session is
// already present, otherwise waits for the auth state to settle, up to
// timeoutMs. Never throws.
export async function waitForSession(timeoutMs = 6000) {
  try {
    const supabase = await getSupabase();
    if (!supabase) return null;
    const existing = (await supabase.auth.getSession())?.data?.session ?? null;
    if (existing) return existing;
    return await new Promise((resolve) => {
      let settled = false;
      let sub = null;
      const finish = (session) => {
        if (settled) return;
        settled = true;
        try {
          sub?.subscription?.unsubscribe();
        } catch {
          /* ignore */
        }
        resolve(session ?? null);
      };
      const result = supabase.auth.onAuthStateChange((_event, session) => {
        if (session) finish(session);
      });
      sub = result?.data ?? null;
      window.setTimeout(() => finish(null), timeoutMs);
    });
  } catch (error) {
    console.info("waitForSession failed", error);
    return null;
  }
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
