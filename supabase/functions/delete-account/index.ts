// delete-account — Data Deletion + Privacy (Master Features #29).
// One irreversible request that genuinely erases a person from Gems:
//   1. every edited output they generated (Storage bucket "edits")
//   2. the auth user itself — which CASCADES every owned DB row
//      (profiles → consents, profile_aesthetics, custom_aesthetic_events,
//       projects → project_photos → edit_versions, taste_events,
//       pack_applications) via the on-delete-cascade FKs from the v1 schema.
// Original photos never lived server-side, so there is nothing else to erase.
// verify_jwt gates every call; the body must explicitly confirm.
import { createClient } from "npm:@supabase/supabase-js@2";

const EDITS_BUCKET = "edits";
const LIST_PAGE = 100; // Storage list page size while walking the user's tree.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// The gateway verified the JWT signature (verify_jwt); the payload sub is
// trustworthy. We additionally require role=authenticated so an anon/service
// token can never drive a deletion.
function userIdFromAuth(header: string | null): string | null {
  try {
    const token = header?.replace(/^Bearer\s+/i, "") ?? "";
    const payload = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), (c) =>
          c.charCodeAt(0),
        ),
      ),
    );
    if (payload.role !== "authenticated") return null;
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

// Recursively enumerate every object under `${prefix}/` in a bucket. Storage
// `.list` returns files (with metadata) and folder prefixes (id === null); we
// walk into the folders so nested edit outputs (`${userId}/${photoId}/…`) are
// all collected. Throws on a list error so the caller can report the step.
async function listAllObjects(
  supabase: ReturnType<typeof createClient>,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const files: string[] = [];
  const folders: string[] = [prefix];
  while (folders.length) {
    const dir = folders.pop()!;
    let offset = 0;
    // Page through this folder until a short page signals the end.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { data, error } = await supabase.storage.from(bucket).list(dir, {
        limit: LIST_PAGE,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw new Error(`storage list failed at "${dir}": ${error.message}`);
      const entries = data ?? [];
      for (const entry of entries) {
        const full = dir ? `${dir}/${entry.name}` : entry.name;
        // A null id marks a folder prefix rather than a real object.
        if (entry.id === null) folders.push(full);
        else files.push(full);
      }
      if (entries.length < LIST_PAGE) break;
      offset += LIST_PAGE;
    }
  }
  return files;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (request.method !== "POST") return json(405, { error: "POST only" });

  const userId = userIdFromAuth(request.headers.get("authorization"));
  if (!userId) return json(401, { error: "no user" });

  // The body is optional but confirmation is mandatory — a deletion must be
  // an explicit, intentional act, never a stray POST.
  let body: { confirm?: boolean } = {};
  try {
    const raw = await request.text();
    if (raw.trim()) body = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid JSON body" });
  }
  if (body.confirm !== true) {
    return json(400, { error: "confirmation required", detail: "send { confirm: true }" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    console.error("delete-account: service credentials not configured");
    return json(503, { error: "server not configured" });
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  // ---- Step 1: erase every edited output under `${userId}/` in "edits".
  // Do this FIRST: if it fails we abort before touching the account, so the
  // person is never left half-deleted (account gone, files orphaned).
  let removedCount = 0;
  try {
    const paths = await listAllObjects(supabase, EDITS_BUCKET, userId);
    for (let i = 0; i < paths.length; i += LIST_PAGE) {
      const chunk = paths.slice(i, i + LIST_PAGE);
      const { error: removeError } = await supabase.storage.from(EDITS_BUCKET).remove(chunk);
      if (removeError) {
        throw new Error(`storage remove failed: ${removeError.message}`);
      }
      removedCount += chunk.length;
    }
  } catch (error) {
    console.error("delete-account: storage step failed", error);
    return json(502, {
      error: "storage_delete_failed",
      step: "storage",
      detail: String((error as Error).message ?? error),
    });
  }

  // ---- Step 2: delete the auth user. This cascades every owned DB row.
  try {
    const { error: deleteError } = await supabase.auth.admin.deleteUser(userId);
    if (deleteError) {
      // Storage is already gone; surface that the account itself remains so
      // the caller (and the person) know the exact half-state to retry from.
      console.error("delete-account: auth deleteUser failed", deleteError);
      return json(502, {
        error: "account_delete_failed",
        step: "account",
        storageObjectsRemoved: removedCount,
        detail: deleteError.message,
      });
    }
  } catch (error) {
    console.error("delete-account: auth deleteUser threw", error);
    return json(502, {
      error: "account_delete_failed",
      step: "account",
      storageObjectsRemoved: removedCount,
      detail: String((error as Error).message ?? error),
    });
  }

  // Server-side breadcrumb only — never echo user data back beyond the result.
  console.log(`delete-account: erased account ${userId} (${removedCount} storage objects)`);
  return json(200, { deleted: true, storageObjectsRemoved: removedCount });
});
