-- ============================================================
-- GEMS — Explicit post-upload recovery transition
-- ============================================================

begin;

create or replace function public.mark_scene_generation_recoverable(
  p_job_id uuid,
  p_profile_id uuid,
  p_attempt_id uuid,
  p_lease_token uuid,
  p_error_code text default 'generation_output_record_deferred'
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job public.generation_jobs%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_profile_id::text, 0));
  select j.* into v_job
  from public.generation_jobs j
  where j.id = p_job_id and j.profile_id = p_profile_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'scene_job_missing';
  end if;
  if v_job.status = 'indeterminate'
    and v_job.active_attempt_id = p_attempt_id
    and v_job.lease_token = p_lease_token then
    return true;
  end if;
  if v_job.status <> 'generating'
    or v_job.active_attempt_id is distinct from p_attempt_id
    or v_job.lease_token is distinct from p_lease_token then
    return false;
  end if;

  update public.generation_attempts a
  set status = 'indeterminate',
      error_code = left(coalesce(p_error_code, 'generation_output_record_deferred'), 120),
      error_detail = 'A deterministic output may exist and must be recovered before any retry.',
      completed_at = now()
  where a.id = p_attempt_id
    and a.job_id = p_job_id
    and a.profile_id = p_profile_id
    and a.lease_token = p_lease_token
    and a.status = 'started';

  update public.generation_jobs j
  set status = 'indeterminate',
      error_code = left(coalesce(p_error_code, 'generation_output_record_deferred'), 120),
      error_detail = 'A deterministic output may exist and must be recovered before any retry.',
      lease_expires_at = null,
      completed_at = now()
  where j.id = p_job_id and j.status = 'generating';

  update public.credit_reservations r
  set status = 'consumed', finalized_at = now()
  where r.job_id = p_job_id and r.status = 'reserved';

  return true;
end;
$$;

revoke all on function public.mark_scene_generation_recoverable(
  uuid, uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.mark_scene_generation_recoverable(
  uuid, uuid, uuid, uuid, text
) to service_role;

commit;
