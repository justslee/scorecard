-- Caddie persistence + shot tracking + player learning
-- Depends on 001_course_mapping_schema.sql (PostGIS, courses, holes, etc.)

create extension if not exists pgcrypto;

-- ── Persistent caddie session (replaces in-memory SessionManager) ──

create table if not exists public.caddie_sessions (
  round_id text primary key,
  user_id text,
  course_id uuid references public.courses(id) on delete set null,
  personality_id text not null default 'classic',
  current_hole int not null default 1,
  -- cached round-scoped data
  weather jsonb,
  weather_fetched_at timestamptz,
  hole_intel jsonb not null default '{}'::jsonb,
  player_stats jsonb,
  last_recommendation jsonb,
  shot_history jsonb not null default '[]'::jsonb,
  club_distances jsonb not null default '{}'::jsonb,
  handicap numeric,
  status text not null default 'active' check (status in ('active','ended')),
  realtime_session_id text,
  created_at timestamptz not null default now(),
  last_accessed timestamptz not null default now(),
  ended_at timestamptz
);

create index if not exists caddie_sessions_user_idx on public.caddie_sessions(user_id, status);
create index if not exists caddie_sessions_last_accessed_idx on public.caddie_sessions(last_accessed) where status = 'active';

-- ── Conversation history (one row per turn) ──

create table if not exists public.caddie_messages (
  id bigserial primary key,
  round_id text not null references public.caddie_sessions(round_id) on delete cascade,
  hole_number int,
  role text not null check (role in ('user','assistant','tool')),
  content text not null,
  tool_calls jsonb,
  audio_url text,
  latency_ms int,
  created_at timestamptz not null default now()
);

create index if not exists caddie_messages_round_idx on public.caddie_messages(round_id, created_at);

-- ── Aggregated player profile (recomputed nightly from shots) ──

create table if not exists public.player_profiles (
  user_id text primary key,
  handicap numeric,
  club_distances jsonb not null default '{}'::jsonb,
  miss_direction text default 'balanced',
  miss_short_pct numeric default 55,
  three_putts_per_round numeric default 2,
  par5_bogey_rate numeric default 20,
  personal_sg jsonb not null default '{}'::jsonb,
  prefers_terse boolean default false,
  distance_pref text default 'center',
  preferred_personality_id text default 'classic',
  rounds_analyzed int not null default 0,
  updated_at timestamptz not null default now()
);

-- ── Caddie memory (LLM-friendly summaries injected into future rounds) ──

create table if not exists public.caddie_memories (
  id bigserial primary key,
  user_id text not null,
  round_id text references public.caddie_sessions(round_id) on delete set null,
  summary text not null,
  kind text not null check (kind in ('tendency','preference','course_history','incident')),
  weight numeric not null default 1.0,
  created_at timestamptz not null default now()
);

create index if not exists caddie_memories_user_idx on public.caddie_memories(user_id, kind, created_at desc);

-- ── Shot tracking (PR #4 will populate; included here so schema is stable) ──

create table if not exists public.shots (
  id bigserial primary key,
  round_id text not null,
  user_id text,
  hole_id uuid references public.holes(id) on delete set null,
  hole_number int not null,
  shot_number int not null,
  start_lat double precision,
  start_lng double precision,
  start_lie text,
  end_lat double precision,
  end_lng double precision,
  end_lie text,
  start_geom geography(point, 4326),
  end_geom geography(point, 4326),
  distance_yards numeric,
  club text,
  intended_target_lat double precision,
  intended_target_lng double precision,
  result text,
  strokes_gained numeric,
  wind_speed_mph numeric,
  wind_direction int,
  pressure_hpa numeric,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists shots_user_idx on public.shots(user_id, created_at desc);
create index if not exists shots_round_idx on public.shots(round_id, hole_number, shot_number);
create index if not exists shots_start_geom_gix on public.shots using gist (start_geom);

-- ── Daily pin sheets ──

create table if not exists public.hole_pins (
  id uuid primary key default gen_random_uuid(),
  hole_id uuid not null references public.holes(id) on delete cascade,
  pin_date date not null,
  pin_lat double precision not null,
  pin_lng double precision not null,
  pin_geom geography(point, 4326) not null,
  source text not null default 'manual' check (source in ('manual','admin','estimated')),
  created_at timestamptz not null default now(),
  unique(hole_id, pin_date)
);

create index if not exists hole_pins_date_idx on public.hole_pins(pin_date);

-- ── Elevation tile cache ──

create table if not exists public.elevation_cache (
  id bigserial primary key,
  lat_q int not null,
  lng_q int not null,
  elevation_ft numeric not null,
  created_at timestamptz not null default now(),
  unique(lat_q, lng_q)
);

-- ── Augment existing tables (nullable, no backfill needed) ──

alter table public.holes
  add column if not exists tee_elevation_ft numeric,
  add column if not exists green_elevation_ft numeric,
  add column if not exists green_slope jsonb;

alter table public.hole_features
  add column if not exists source text default 'manual',
  add column if not exists confidence numeric default 1.0;

-- ── updated_at trigger on player_profiles ──

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'set_updated_at_player_profiles') then
    create trigger set_updated_at_player_profiles before update on public.player_profiles
    for each row execute function public.set_updated_at();
  end if;
end $$;
