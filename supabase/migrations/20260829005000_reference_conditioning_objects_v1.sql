-- Persist the exact <=1024px bytes that were embedded. Retrieval must never
-- regenerate a transformation and assume it has the same bytes/hash.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'inspiration-conditioning',
  'inspiration-conditioning',
  false,
  4194304,
  array['image/jpeg', 'image/png']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = 4194304,
    allowed_mime_types = array['image/jpeg', 'image/png']::text[];

alter table public.inspiration_assets
  add column if not exists conditioning_storage_bucket text,
  add column if not exists conditioning_storage_path text;

update public.inspiration_assets
set index_status = 'pending',
    embedding = null,
    visual_embedding = null,
    conditioning_sha256 = null,
    conditioning_storage_bucket = null,
    conditioning_storage_path = null,
    indexed_at = null,
    index_error = 'conditioning derivative requires durable backfill'
where index_status = 'ready'
  and conditioning_storage_path is null;

alter table public.inspiration_assets
  drop constraint if exists inspiration_assets_conditioning_object_shape;
alter table public.inspiration_assets
  add constraint inspiration_assets_conditioning_object_shape check (
    index_status <> 'ready'
    or (
      conditioning_storage_bucket = 'inspiration-conditioning'
      and conditioning_storage_path is not null
      and conditioning_storage_path ~
        '^([0-9a-f-]{36}/reference|style-pack)/[0-9a-f-]{36}/[a-f0-9]{64}\.(jpg|png)$'
      and conditioning_sha256 ~ '^[a-f0-9]{64}$'
      and embedding is not null
      and visual_embedding is not null
    )
  );

create unique index if not exists inspiration_assets_conditioning_path_uidx
  on public.inspiration_assets (
    conditioning_storage_bucket,
    conditioning_storage_path
  )
  where conditioning_storage_path is not null;

-- No client Storage policy is created for this bucket. Reads and writes are
-- performed only by service-role indexing/retrieval code after its own scope
-- and rights checks.
