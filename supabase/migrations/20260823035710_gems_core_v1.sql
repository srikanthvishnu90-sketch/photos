-- ============================================================
-- GEMS — v1 core schema
-- Migration: gems_core_v1
-- Applied to project hkwkxacvcgorhthwyslx (gems) on 2026-08-22
-- Principles encoded here:
--   1. RLS on from the first migration, owner-only everywhere.
--   2. Photos NEVER live in this database. project_photos stores
--      PhotoKit local identifiers + derived metadata only.
--      Supabase Storage holds ONLY edited outputs the user
--      explicitly generated.
--   3. Behavioral taste data (taste_events) is a first-class
--      table from day one — it is the future model's training set.
--   4. Training consent is explicit, separate, and default-off.
--   5. No face embeddings or biometric templates server-side, ever
--      (Illinois BIPA). Face work stays on-device.
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- profiles ----------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 60),
  gender      text check (gender in ('female', 'male', 'unspecified')),
  age_range   text check (age_range in ('under_18', '18_21', '22_29', '30_plus')),
  plan        text not null default 'free' check (plan in ('free', 'plus')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles: owner read"   on public.profiles for select using (auth.uid() = id);
create policy "profiles: owner insert" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles: owner update" on public.profiles for update using (auth.uid() = id);

-- Auto-create a profile row on signup (name filled during onboarding)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', 'New user'));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- consents (explicit, separate, default-off) ----------
create table public.consents (
  profile_id        uuid primary key references public.profiles (id) on delete cascade,
  training_opt_in   boolean not null default false,
  discover_feature_opt_in boolean not null default false,
  updated_at        timestamptz not null default now()
);

alter table public.consents enable row level security;
create policy "consents: owner all" on public.consents
  for all using (auth.uid() = profile_id) with check (auth.uid() = profile_id);

-- ---------- aesthetics (onboarding picks + later changes) ----------
create table public.profile_aesthetics (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  label       text not null check (char_length(label) between 1 and 60),
  is_custom   boolean not null default false,
  position    smallint not null default 0,
  created_at  timestamptz not null default now(),
  unique (profile_id, label)
);

alter table public.profile_aesthetics enable row level security;
create policy "aesthetics: owner all" on public.profile_aesthetics
  for all using (auth.uid() = profile_id) with check (auth.uid() = profile_id);

create index idx_profile_aesthetics_profile on public.profile_aesthetics (profile_id);

-- ---------- custom aesthetic analytics (the taste-vocabulary dataset) ----------
-- Insert-only from the client; users can read their own entries.
create table public.custom_aesthetic_events (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references public.profiles (id) on delete cascade,
  raw_text      text not null check (char_length(raw_text) between 1 and 80),
  gender        text,
  age_range     text,
  co_selections jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now()
);

alter table public.custom_aesthetic_events enable row level security;
create policy "cae: owner insert" on public.custom_aesthetic_events
  for insert with check (auth.uid() = profile_id);
create policy "cae: owner read" on public.custom_aesthetic_events
  for select using (auth.uid() = profile_id);

create index idx_cae_created on public.custom_aesthetic_events (created_at);

-- ---------- projects (dumps, edits, template posts, moodboards) ----------
create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  kind        text not null check (kind in ('dump', 'edit', 'template', 'moodboard')),
  template_slug text,                          -- e.g. 'college_commitment', null unless kind='template'
  name        text not null default 'Untitled' check (char_length(name) <= 80),
  status      text not null default 'draft' check (status in ('draft', 'exported', 'archived')),
  aesthetic   text,                             -- primary vibe applied to the set
  meta        jsonb not null default '{}'::jsonb, -- prompt history, target platform, slot count…
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.projects enable row level security;
create policy "projects: owner all" on public.projects
  for all using (auth.uid() = profile_id) with check (auth.uid() = profile_id);

create index idx_projects_profile_updated on public.projects (profile_id, updated_at desc);

-- ---------- project_photos (references + derived data, never pixels) ----------
create table public.project_photos (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  profile_id     uuid not null references public.profiles (id) on delete cascade,
  position       smallint not null default 0,
  asset_local_id text not null,                 -- PhotoKit localIdentifier; the photo stays on-device
  role           text,                          -- 'cover' | 'candid' | 'wide' | 'detail' | 'closer' | …
  ai_selected    boolean not null default true, -- false = user manually inserted
  kept           boolean,                       -- null until export; true/false = accept/swap signal
  derived        jsonb not null default '{}'::jsonb, -- on-device scores: quality, saliency box, dupe group…
  storage_path   text,                          -- ONLY set when an edited output was generated
  created_at     timestamptz not null default now()
);

alter table public.project_photos enable row level security;
create policy "project_photos: owner all" on public.project_photos
  for all using (auth.uid() = profile_id) with check (auth.uid() = profile_id);

create index idx_project_photos_project on public.project_photos (project_id, position);

-- ---------- edit_versions (Editor: Original / V1 / V2 / re-rolls) ----------
create table public.edit_versions (
  id              uuid primary key default gen_random_uuid(),
  project_photo_id uuid not null references public.project_photos (id) on delete cascade,
  profile_id      uuid not null references public.profiles (id) on delete cascade,
  version_number  smallint not null,
  kind            text not null check (kind in ('describe', 'manual', 'reroll', 'style_match', 'template')),
  prompt          text,                          -- the user's instruction, verbatim
  model_ref       text,                          -- which editing model/version produced it
  storage_path    text,                          -- edited output in Storage
  accepted        boolean,                       -- did this version survive to export
  created_at      timestamptz not null default now(),
  unique (project_photo_id, version_number)
);

alter table public.edit_versions enable row level security;
create policy "edit_versions: owner all" on public.edit_versions
  for all using (auth.uid() = profile_id) with check (auth.uid() = profile_id);

create index idx_edit_versions_photo on public.edit_versions (project_photo_id, version_number);

-- ---------- taste_events (the behavioral pipeline — future model's food) ----------
-- Append-only from the client. Every meaningful choice lands here:
--   gem_tapped, gem_ignored, dump_photo_kept, dump_photo_swapped,
--   aesthetic_applied, edit_accepted, edit_rerolled, cover_chosen,
--   discover_recreate_tapped, search_query …
create table public.taste_events (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  event_type  text not null check (char_length(event_type) <= 60),
  subject     jsonb not null default '{}'::jsonb, -- what it happened to (ids, labels, positions)
  created_at  timestamptz not null default now()
);

alter table public.taste_events enable row level security;
create policy "taste_events: owner insert" on public.taste_events
  for insert with check (auth.uid() = profile_id);
create policy "taste_events: owner read" on public.taste_events
  for select using (auth.uid() = profile_id);

create index idx_taste_events_profile_time on public.taste_events (profile_id, created_at desc);
create index idx_taste_events_type on public.taste_events (event_type, created_at desc);

-- ---------- updated_at housekeeping ----------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_profiles_touch  before update on public.profiles  for each row execute function public.touch_updated_at();
create trigger trg_projects_touch  before update on public.projects  for each row execute function public.touch_updated_at();
create trigger trg_consents_touch  before update on public.consents  for each row execute function public.touch_updated_at();
