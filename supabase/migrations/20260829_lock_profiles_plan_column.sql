-- SECURITY (2026-08-29): profiles.plan is a BILLING field and was writable by
-- any signed-in user.
--
-- RLS restricts which ROWS a user may update, never which COLUMNS. The
-- "profiles: owner update" policy (using auth.uid() = id) therefore allowed:
--
--   update profiles set plan = 'plus' where id = auth.uid();
--
-- straight from the client with the publishable key, granting unlimited paid AI
-- generations — every cap check in the edge functions reads this column.
-- PROVEN exploitable in a rolled-back transaction against the live database
-- before this fix, and proven blocked ("permission denied for table profiles")
-- after it. No user had actually done it: all 7 profiles were still 'free'.
--
-- NOTE for the next person: a column-level `revoke update (plan)` is a NO-OP
-- here, because `authenticated` holds a TABLE-level UPDATE grant that covers
-- every column and a column revoke cannot subtract from it. The table-wide
-- privilege has to go first, then be granted back per column.
revoke update, insert on public.profiles from anon, authenticated;

-- onboarding-api.js is the ONLY writer and sends exactly these columns.
grant insert (id, display_name, gender, age_range) on public.profiles to authenticated;
-- `id` stays writable because it is the upsert conflict key; the owner-update
-- policy still forbids pointing a row at another user.
grant update (id, display_name, gender, age_range, updated_at) on public.profiles to authenticated;

-- `plan` is absent from both grants on purpose: only service_role (the edge
-- functions) may set it, which is where a real subscription upgrade belongs.
