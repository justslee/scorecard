-- Golf course mapping schema (Supabase/Postgres + PostGIS)
-- Run in Supabase SQL editor or via migration tooling.

-- Enable PostGIS
create extension if not exists postgis;

-- Courses (high level)
create table if not exists public.courses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  location geography(point, 4326),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Tee sets (Blue/White/etc)
create table if not exists public.tee_sets (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  name text not null,
  color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(course_id, name)
);

-- Holes (par/handicap)
create table if not exists public.holes (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  hole_number int not null check (hole_number between 1 and 18),
  par int not null check (par between 3 and 6),
  handicap int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(course_id, hole_number)
);

-- Per-tee yardages
create table if not exists public.hole_yardages (
  id uuid primary key default gen_random_uuid(),
  hole_id uuid not null references public.holes(id) on delete cascade,
  tee_set_id uuid not null references public.tee_sets(id) on delete cascade,
  yards int not null check (yards >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(hole_id, tee_set_id)
);

-- Geospatial features per hole (polygons/points)
-- Feature types: tee, fairway, green, bunker, water, ob, target, pin
create table if not exists public.hole_features (
  id uuid primary key default gen_random_uuid(),
  hole_id uuid not null references public.holes(id) on delete cascade,
  feature_type text not null,
  tee_set_id uuid references public.tee_sets(id) on delete set null,
  -- use geometry so we can store Point/Polygon/MultiPolygon
  geom geometry(Geometry, 4326) not null,
  properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Basic indexes
create index if not exists courses_location_gix on public.courses using gist (location);
create index if not exists hole_features_geom_gix on public.hole_features using gist (geom);
create index if not exists holes_course_hole_idx on public.holes(course_id, hole_number);
create index if not exists tee_sets_course_idx on public.tee_sets(course_id);

-- updated_at trigger helper
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'set_updated_at_courses'
  ) then
    create trigger set_updated_at_courses before update on public.courses
    for each row execute function public.set_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'set_updated_at_tee_sets'
  ) then
    create trigger set_updated_at_tee_sets before update on public.tee_sets
    for each row execute function public.set_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'set_updated_at_holes'
  ) then
    create trigger set_updated_at_holes before update on public.holes
    for each row execute function public.set_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'set_updated_at_hole_yardages'
  ) then
    create trigger set_updated_at_hole_yardages before update on public.hole_yardages
    for each row execute function public.set_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'set_updated_at_hole_features'
  ) then
    create trigger set_updated_at_hole_features before update on public.hole_features
    for each row execute function public.set_updated_at();
  end if;
end $$;
