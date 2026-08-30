-- Option C: fix the generate-scene free-tier metering RACE without adopting the
-- full durable-job engine.
--
-- The old edge-function meter READ the scene_generated events, decided, then
-- (after the model call) INSERTED one — a classic TOCTOU: two concurrent
-- requests with the same fresh requestId both read zero and both generate,
-- exceeding the one-free-request cap. This RPC collapses the check and the
-- reservation into ONE statement under a per-profile advisory lock, so
-- concurrent requests serialize and the cap is enforced atomically.
--
-- The inserted row IS the meter event: the edge function finalizes it (enriches
-- its subject) on success, or deletes it (releases) on any failure — so a failed
-- generation never consumes the free request.
begin;

create or replace function public.reserve_free_scene_slot(
  p_profile_id uuid,
  p_request_id text,
  p_max_images integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_plan text;
  v_from_another integer;
  v_this_request integer;
  v_reservation_id uuid;
begin
  -- Serialize concurrent reservations for this profile — this is the fix.
  perform pg_advisory_xact_lock(hashtextextended(p_profile_id::text, 0));

  select plan into v_plan from public.profiles where id = p_profile_id;
  if not found then
    return jsonb_build_object('allow', false, 'reason', 'profile_missing');
  end if;

  -- Plus is unlimited: allow with no reservation row.
  if coalesce(v_plan, 'free') <> 'free' then
    return jsonb_build_object('allow', true, 'reason', 'plus', 'reservation_id', null);
  end if;

  -- Free tier = ONE request (any number of images up to the cap). A no-id call,
  -- any prior generation from a DIFFERENT request, or hitting the per-request
  -- image cap → deny. (Legacy events with no request_id count as another request.)
  if coalesce(p_request_id, '') = '' then
    return jsonb_build_object('allow', false, 'reason', 'no_request_id');
  end if;

  select
    count(*) filter (where coalesce(subject ->> 'request_id', '__legacy__') <> p_request_id),
    count(*) filter (where subject ->> 'request_id' = p_request_id)
  into v_from_another, v_this_request
  from public.taste_events
  where profile_id = p_profile_id and event_type = 'scene_generated';

  if v_from_another > 0 or v_this_request >= p_max_images then
    return jsonb_build_object('allow', false, 'reason', 'free_prompt_used', 'cap', p_max_images);
  end if;

  -- Reserve atomically INSIDE the lock, so a concurrent request sees it.
  insert into public.taste_events (profile_id, event_type, subject)
  values (
    p_profile_id, 'scene_generated',
    jsonb_build_object('request_id', p_request_id, 'reserved', true)
  )
  returning id into v_reservation_id;

  return jsonb_build_object('allow', true, 'reason', 'reserved', 'reservation_id', v_reservation_id);
end;
$$;

revoke all on function public.reserve_free_scene_slot(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.reserve_free_scene_slot(uuid, text, integer)
  to service_role;

commit;
