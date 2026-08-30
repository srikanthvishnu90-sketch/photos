// review-references — founder-only curation of the global reference libraries.
// GET  ?pack=<packId|_realism>&token=<t>  -> { pack, images:[{name,url}] } signed
// POST { pack, token, remove:[names] }    -> { removed } deletes those objects
//
// Gated by a shared REVIEW_TOKEN secret (no user JWT — this is an admin tool the
// founder opens with a link). Only ever touches the private `inspiration` bucket
// under _global/. verify_jwt is OFF for this function (see config.toml); the
// token is the gate.
import { createClient } from "npm:@supabase/supabase-js@2";

const PACKS = new Set([
  "euro-summer", "dubai", "old-money", "luxury-cars",
  "beach-club", "boat", "dark-luxe", "after-dark",
]);
const SIGNED_SECONDS = 60 * 60 * 6;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type, apikey",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    },
  });
}

function prefixFor(pack: string): string | null {
  if (pack === "_realism") return "_global/realism";
  if (PACKS.has(pack)) return `_global/packs/${pack}`;
  return null;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return json(200, { ok: true });

  const REVIEW_TOKEN = Deno.env.get("REVIEW_TOKEN") ?? "";
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    if (request.method === "GET") {
      const url = new URL(request.url);
      const token = url.searchParams.get("token") ?? "";
      const pack = url.searchParams.get("pack") ?? "";
      if (!REVIEW_TOKEN || token !== REVIEW_TOKEN) return json(401, { error: "bad token" });
      const prefix = prefixFor(pack);
      if (!prefix) return json(400, { error: "bad pack" });

      const { data: files, error } = await supabase.storage
        .from("inspiration").list(prefix, { limit: 1000, sortBy: { column: "name", order: "asc" } });
      if (error) return json(502, { error: error.message });
      const imgs = (files ?? []).filter((f) => f.name && /\.(jpe?g|png|webp)$/i.test(f.name));

      const images: Array<{ name: string; url: string }> = [];
      // Batch sign for speed.
      const paths = imgs.map((f) => `${prefix}/${f.name}`);
      const { data: signed } = await supabase.storage.from("inspiration").createSignedUrls(paths, SIGNED_SECONDS);
      const byPath = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));
      for (const f of imgs) {
        const u = byPath.get(`${prefix}/${f.name}`);
        if (u) images.push({ name: f.name, url: u });
      }
      return json(200, { pack, count: images.length, images });
    }

    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (!REVIEW_TOKEN || body.token !== REVIEW_TOKEN) return json(401, { error: "bad token" });
      const prefix = prefixFor(String(body.pack ?? ""));
      if (!prefix) return json(400, { error: "bad pack" });
      const remove = Array.isArray(body.remove) ? body.remove.filter((n: unknown) => typeof n === "string") : [];
      if (!remove.length) return json(200, { removed: 0 });
      // Only names within this prefix; never allow path traversal.
      const paths = remove
        .filter((n: string) => /^[A-Za-z0-9._-]+\.(jpe?g|png|webp)$/i.test(n))
        .map((n: string) => `${prefix}/${n}`);
      const { data, error } = await supabase.storage.from("inspiration").remove(paths);
      if (error) return json(502, { error: error.message });
      return json(200, { removed: (data ?? []).length, requested: paths.length });
    }

    return json(405, { error: "method not allowed" });
  } catch (error) {
    return json(500, { error: String((error as Error).message ?? error) });
  }
});
