-- Minimal Supabase catalog compatibility for disposable PostgreSQL acceptance
-- clusters. This is test scaffolding only; production uses Supabase-owned
-- auth/storage schemas and roles.

do $$
begin
  create role anon nologin;
exception when duplicate_object then null;
end
$$;

do $$
begin
  create role authenticated nologin;
exception when duplicate_object then null;
end
$$;

do $$
begin
  create role service_role nologin bypassrls;
exception when duplicate_object then null;
end
$$;

create schema if not exists extensions;
create schema if not exists auth;
create schema if not exists storage;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;

create table if not exists auth.users (
  instance_id uuid,
  id uuid primary key,
  aud text,
  role text,
  email text,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmation_token text not null default '',
  email_change text not null default '',
  email_change_token_new text not null default '',
  recovery_token text not null default ''
);

create or replace function auth.uid()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_sub text;
  v_claims text;
begin
  v_sub := nullif(current_setting('request.jwt.claim.sub', true), '');
  if v_sub is null then
    v_claims := nullif(current_setting('request.jwt.claims', true), '');
    if v_claims is not null then
      v_sub := (v_claims::jsonb ->> 'sub');
    end if;
  end if;
  return nullif(v_sub, '')::uuid;
exception when others then
  return null;
end
$$;

create or replace function auth.role()
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_role text;
  v_claims text;
begin
  v_role := nullif(current_setting('request.jwt.claim.role', true), '');
  if v_role is null then
    v_claims := nullif(current_setting('request.jwt.claims', true), '');
    if v_claims is not null then
      v_role := (v_claims::jsonb ->> 'role');
    end if;
  end if;
  return v_role;
exception when others then
  return null;
end
$$;

grant usage on schema auth, storage to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role()
  to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id uuid primary key default extensions.gen_random_uuid(),
  bucket_id text not null references storage.buckets(id) on delete cascade,
  name text not null,
  owner uuid,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bucket_id, name)
);

alter table storage.objects enable row level security;

create or replace function storage.foldername(name text)
returns text[]
language sql
immutable
strict
set search_path = ''
as $$
  select string_to_array(name, '/')
$$;

grant select, insert, update, delete on storage.objects
  to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated, service_role;
grant execute on function storage.foldername(text)
  to anon, authenticated, service_role;
