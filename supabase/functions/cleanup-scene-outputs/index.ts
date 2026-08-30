// cleanup-scene-outputs — scheduled, idempotent deletion of terminal scene
// output candidates after the generation lease/grace tombstone becomes due.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-gems-cleanup-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function secretsMatch(actual: string, expected: string): Promise<boolean> {
  if (!actual || !expected) return false;
  const [a, b] = await Promise.all([sha256(actual), sha256(expected)]);
  if (a.byteLength !== b.byteLength) return false;
  let different = 0;
  for (let i = 0; i < a.byteLength; i++) different |= a[i] ^ b[i];
  return different === 0;
}

function expectedPaths(profileId: string, jobId: string): string[] {
  const prefix = `${profileId}/scene/${jobId}/output`;
  return [`${prefix}.jpg`, `${prefix}.png`, `${prefix}.webp`];
}

function exactPaths(value: unknown, profileId: string, jobId: string): string[] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const supplied = value.map(String).sort();
  const expected = expectedPaths(profileId, jobId).sort();
  return expected.every((path, index) => path === supplied[index]) ? expected : null;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (request.method !== "POST") return json(405, { error: "POST only" });

  const configuredSecret = Deno.env.get("SCENE_CLEANUP_SECRET") ?? "";
  const suppliedSecret = request.headers.get("x-gems-cleanup-secret") ?? "";
  if (!(await secretsMatch(suppliedSecret, configuredSecret))) {
    return json(401, { error: "unauthorized" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceRoleKey) return json(503, { error: "server_not_configured" });
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: rows, error: listError } = await supabase.rpc(
    "list_due_scene_output_cleanups",
    { p_limit: 50 },
  );
  if (listError) {
    console.error("scene cleanup janitor lookup failed", listError);
    return json(503, { error: "cleanup_state_unavailable" });
  }

  let cleaned = 0;
  let deferred = 0;
  for (const row of rows ?? []) {
    const jobId = String(row.job_id ?? "");
    const profileId = String(row.profile_id ?? "");
    const paths = exactPaths(row.cleanup_paths, profileId, jobId);
    if (!UUID_RE.test(jobId) || !UUID_RE.test(profileId)
      || row.cleanup_bucket !== "edits" || !paths) {
      console.error("scene cleanup janitor rejected an invalid contract", { jobId });
      deferred++;
      continue;
    }

    const { error: removeError } = await supabase.storage.from("edits").remove(paths);
    if (removeError) {
      console.error("scene cleanup janitor storage removal failed", { jobId, error: removeError });
      deferred++;
      continue;
    }
    const { data: acknowledged, error: acknowledgeError } = await supabase.rpc(
      "acknowledge_scene_output_cleanup",
      { p_job_id: jobId, p_profile_id: profileId },
    );
    if (acknowledgeError || acknowledged !== true) {
      console.error("scene cleanup janitor acknowledgement failed", { jobId, error: acknowledgeError });
      deferred++;
      continue;
    }
    cleaned++;
  }

  return json(deferred ? 207 : 200, {
    inspected: (rows ?? []).length,
    cleaned,
    deferred,
  });
});
