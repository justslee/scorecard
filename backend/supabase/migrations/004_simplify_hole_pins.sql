-- Simplify hole_pins to work without the full PostGIS course-mapping schema.
--
-- The original definition (migration 002) keyed pins by holes.id (uuid). That
-- requires courses + holes to be seeded for every course pins are marked on,
-- which most courses won't have until we ingest from GolfAPI / OSM. Pin
-- marking is the fastest-shippable feature in Phase 2 and shouldn't block
-- on the broader course-mapping rollout.
--
-- New shape: keyed by (course_id text, hole_number int, pin_date date). The
-- course_id is whatever id the frontend uses (GolfAPI string ids or our own
-- uuids). When PostGIS-backed holes get populated, we can join on a separate
-- mapping table without touching this one.

drop table if exists public.hole_pins cascade;

create table public.hole_pins (
  id uuid primary key default gen_random_uuid(),
  course_id text not null,
  hole_number int not null check (hole_number between 1 and 18),
  pin_date date not null,
  pin_lat double precision not null,
  pin_lng double precision not null,
  pin_geom geography(point, 4326) not null,
  source text not null default 'manual' check (source in ('manual','admin','estimated')),
  marked_by_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(course_id, hole_number, pin_date)
);

create index hole_pins_course_date_idx on public.hole_pins(course_id, pin_date);
create index hole_pins_geom_gix on public.hole_pins using gist (pin_geom);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'set_updated_at_hole_pins') then
    create trigger set_updated_at_hole_pins before update on public.hole_pins
    for each row execute function public.set_updated_at();
  end if;
end $$;
