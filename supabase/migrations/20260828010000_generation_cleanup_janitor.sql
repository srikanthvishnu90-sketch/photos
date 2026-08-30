-- ============================================================
-- GEMS — Generation output cleanup janitor
-- Makes deferred cancellation cleanup independent of another user request.
-- ============================================================

begin;

create or replace function public.list_due_scene_output_cleanups(
  p_limit integer default 25
)
returns table (
  job_id uuid,
  profile_id uuid,
  cleanup_bucket text,
  cleanup_paths text[],
  cleanup_not_before timestamptz
)
language sql
security definer
set search_path = pg_catalog
as $$
  select
    j.id,
    j.profile_id,
    'edits'::text,
    array[
      j.profile_id::text || '/scene/' || j.id::text || '/output.jpg',
      j.profile_id::text || '/scene/' || j.id::text || '/output.png',
      j.profile_id::text || '/scene/' || j.id::text || '/output.webp'
    ]::text[],
    j.cleanup_not_before
  from public.generation_jobs j
  where j.cleanup_required_at is not null
    and j.cleanup_not_before is not null
    and j.cleanup_not_before <= now()
    and j.status in ('failed', 'canceled', 'indeterminate')
  order by j.cleanup_not_before, j.id
  limit greatest(1, least(coalesce(p_limit, 25), 100))
$$;

revoke all on function public.list_due_scene_output_cleanups(integer)
  from public, anon, authenticated;
grant execute on function public.list_due_scene_output_cleanups(integer)
  to service_role;

commit;
