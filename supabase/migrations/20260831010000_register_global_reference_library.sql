-- Register the founder-curated global reference library already present in the
-- private `inspiration` bucket. The deployed generator reads these objects
-- directly; this migration adds durable, queryable metadata without copying
-- image bytes into Postgres or making provider/indexing calls.

begin;

alter table public.inspiration_assets
  alter column profile_id drop not null,
  add column if not exists style_pack_id text;

create unique index if not exists inspiration_assets_global_storage_unique
  on public.inspiration_assets (storage_path)
  where profile_id is null;

insert into public.inspiration_assets (
  profile_id,
  storage_path,
  label,
  source,
  created_at,
  mime_type,
  byte_size,
  style_pack_id
)
select
  null,
  object.name,
  right(object.name, strpos(reverse(object.name), '/') - 1),
  'style_pack',
  coalesce(object.created_at, now()),
  nullif(object.metadata ->> 'mimetype', ''),
  case
    when coalesce(object.metadata ->> 'size', '') ~ '^[0-9]+$'
      then (object.metadata ->> 'size')::bigint
    else null
  end,
  case
    when object.name like '_global/realism/%' then 'realism'
    else split_part(object.name, '/', 3)
  end
from storage.objects as object
where object.bucket_id = 'inspiration'
  and (
    object.name like '_global/packs/%'
    or object.name like '_global/realism/%'
  )
  and object.name ~* '\.(jpe?g|png|webp)$'
  and not exists (
    select 1
    from public.inspiration_assets as existing
    where existing.storage_path = object.name
  )
order by object.name;

comment on column public.inspiration_assets.style_pack_id is
  'Global style-pack category for founder-curated reference objects; null for user uploads.';

commit;
