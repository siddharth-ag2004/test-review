-- Paste this whole file into Supabase > SQL Editor > New query, then click Run. Run it once.

create table if not exists public.tests (
  id        text primary key,
  title     text not null,
  subject   text,
  date      text,
  items     jsonb not null default '[]'::jsonb,
  updated   bigint not null default 0
);

alter table public.tests enable row level security;

-- Only signed-in users (your family's login) can read or change anything.
drop policy if exists "signed-in can do everything on tests" on public.tests;
create policy "signed-in can do everything on tests"
  on public.tests for all to authenticated
  using (true) with check (true);

-- Private bucket for the photos.
insert into storage.buckets (id, name, public)
values ('test-images', 'test-images', false)
on conflict (id) do nothing;

drop policy if exists "signed-in can do everything on test-images" on storage.objects;
create policy "signed-in can do everything on test-images"
  on storage.objects for all to authenticated
  using (bucket_id = 'test-images') with check (bucket_id = 'test-images');
