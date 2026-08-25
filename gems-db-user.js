// Per-account isolation for the on-device stores.
//
// IndexedDB is scoped to the browser ORIGIN, not to the signed-in account. So
// without this, two people who log into different accounts on the same device
// would share the same photos / faces / embeddings — a real data-leak. This
// module namespaces every on-device DB by the current user id, so each account
// only ever sees its OWN imported photos and derived data. Pixels still never
// leave the device; they're just partitioned per account.
import { getSupabase, getSession } from "./gems-supabase.js";

let userId = undefined; // undefined = not yet resolved
const changeListeners = new Set();

function apply(next) {
  const id = next || "anon";
  const first = userId === undefined;
  if (id === userId) return;
  userId = id;
  // On the very first resolution there's nothing to reset; only an actual
  // account SWITCH (login → different user, or logout) fires the listeners.
  if (!first) {
    for (const cb of changeListeners) {
      try { cb(id); } catch (error) { console.info("db-user change listener failed", error); }
    }
    try { window.dispatchEvent(new CustomEvent("gems:db-user-changed", { detail: id })); } catch { /* SSR */ }
  }
}

/** Resolve the current account id (awaiting the session the first time). */
export async function ensureDbUser() {
  if (userId !== undefined) return userId;
  try {
    const session = await getSession();
    apply(session?.user?.id || "anon");
  } catch {
    apply("anon");
  }
  return userId;
}

/** The current account id ("anon" when signed out / unresolved). */
export function currentDbUser() {
  return userId === undefined ? "anon" : userId;
}

/** A per-account DB name for a base store name, e.g. "gems-photolib" → "gems-photolib-<uid>". */
export function dbNameFor(base) {
  return `${base}-${currentDbUser()}`;
}

/** Register a reset callback fired whenever the account switches. Returns an unsubscribe. */
export function onDbUserChange(cb) {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

// Subscribe to auth changes ONCE so a login/logout resets every store to the
// right account. Runs on module load; failures leave us on the resolved user.
(async () => {
  try {
    await ensureDbUser();
    const supabase = await getSupabase();
    supabase?.auth?.onAuthStateChange?.((_event, session) => apply(session?.user?.id || "anon"));
  } catch (error) {
    console.info("db-user auth subscription skipped", error);
  }
})();
