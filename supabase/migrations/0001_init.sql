-- Sketch-to-Drive → multiplayer racing: initial schema.
--
-- All application writes go through Next route handlers using the service-role key,
-- which bypasses RLS. RLS is enabled with no policies so the browser's anon key (used
-- only for Realtime) cannot read/write these tables directly. Realtime uses public
-- channels (obscure room codes) and does not require table access.

-- Players are identified by a device id kept in the browser's localStorage — no login.
create table if not exists public.players (
  device_id  text primary key,
  username   text,
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);

-- Cars a player has drawn + generated (one GLB each).
create table if not exists public.cars (
  id               uuid primary key default gen_random_uuid(),
  owner_device_id  text not null references public.players(device_id) on delete cascade,
  name             text,
  render_url       text,
  glb_url          text,
  rig_spec         jsonb,          -- cached RigSpec (nullable; derived client-side otherwise)
  status           text not null default 'ready',
  created_at       timestamptz not null default now()
);
create index if not exists cars_owner_idx on public.cars (owner_device_id);

-- Racing rooms. Membership is ephemeral (Realtime presence); this row exists so a
-- share-link cold load can render the lobby + current settings before the channel syncs.
create table if not exists public.rooms (
  code             text primary key,           -- short shareable slug
  owner_device_id  text not null,
  status           text not null default 'lobby',  -- lobby | racing | finished
  settings         jsonb not null default '{}'::jsonb, -- trackId|"random", raceType, laps, maxPlayers
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Generation pipeline state (ports the old .data/jobs.json store). The full Job object
-- lives in `data`; we only ever look it up by id.
create table if not exists public.jobs (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.players enable row level security;
alter table public.cars    enable row level security;
alter table public.rooms   enable row level security;
alter table public.jobs    enable row level security;

-- Public bucket for renders + GLBs. Public read via URL; writes go through service role.
insert into storage.buckets (id, name, public)
values ('assets', 'assets', true)
on conflict (id) do nothing;
