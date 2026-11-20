# Nastavenie Supabase (Konto, trasy a jazdy)

Tento návod popisuje nastavenie projektu v [Supabase](https://supabase.com/) pre prihlasovanie cez Google a ukladanie GPX trás a jázd v aplikácii `index.html`.

---

## Krok 1: Adresa projektu a anon kľúč v `index.html`

1. V Supabase Dashboarde otvor **Project Settings → API**.
2. Skopíruj **Project URL** a verejný **anon / publishable** kľúč (nikdy nepoužívaj `service_role` kľúč!).
3. Doplň ich do konštánt v súbore `index.html`:

```js
const SUPABASE_URL = 'https://TVOJ-PROJEKT.supabase.co';
const SUPABASE_ANON_KEY = 'TVOJ_VEREJNY_ANON_KLUC';
```

---

## Krok 2: Tabuľka `routes` (uložené GPX trasy)

Otvor **SQL Editor** v Supabase a spusti:

```sql
create table if not exists public.routes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  distance_m integer not null default 0,
  ascent_m integer not null default 0,
  point_count integer not null default 0,
  gpx_text text not null,
  created_at timestamptz not null default now()
);

create index if not exists routes_user_created_idx
  on public.routes (user_id, created_at desc);

alter table public.routes enable row level security;

grant select, insert, update, delete on public.routes to authenticated;

create policy "Používateľ číta iba svoje trasy"
  on public.routes for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Používateľ ukladá iba svoje trasy"
  on public.routes for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Používateľ maže iba svoje trasy"
  on public.routes for delete
  to authenticated
  using (auth.uid() = user_id);
```

---

## Krok 2b: Tabuľka `activities` (uložené jazdy)

V **SQL Editore** spusti:

```sql
create table if not exists public.activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  duration_s integer not null default 0,
  distance_m integer not null default 0,
  ascent_m integer not null default 0,
  calories integer not null default 0,
  avg_power_w integer not null default 0,
  np_w integer not null default 0,
  avg_hr integer,
  weight_kg numeric(5, 1),
  created_at timestamptz not null default now()
);

create index if not exists activities_user_created_idx
  on public.activities (user_id, created_at desc);

alter table public.activities enable row level security;

grant select, insert, update, delete on public.activities to authenticated;

create policy "Používateľ číta iba svoje jazdy"
  on public.activities for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Používateľ ukladá iba svoje jazdy"
  on public.activities for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Používateľ maže iba svoje jazdy"
  on public.activities for delete
  to authenticated
  using (auth.uid() = user_id);
```

> **Poznámka k existujúcej databáze:** Ak už tabuľky `routes` alebo `activities` máš vytvorené, over si v **Authentication → Policies** (alebo **Table Editor → RLS**), že obe tabuľky majú zapnuté **Row Level Security** a pravidlá s `auth.uid() = user_id`.

---

## Krok 3: Google prihlásenie a URL presmerovanie

1. V Supabase otvor **Authentication → Providers → Google**, zapni ho a doplň Google OAuth **Client ID** a **Client Secret**.
2. V **Authentication → URL Configuration** pridaj do **Redirect URLs** presnú adresu, na ktorej beží `index.html` (napr. `http://localhost:8000/index.html` alebo tvoju produkčnú URL). Prihlasovanie nefunguje pri priamom otvorení z disku cez `file://`.
