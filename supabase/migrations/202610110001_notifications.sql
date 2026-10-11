-- Separate free project for accounts and notifications. No search/media storage.
create table public.teacher_follows (
  user_id uuid not null references auth.users(id) on delete cascade,
  teacher_id integer not null check (teacher_id > 0),
  teacher_name text not null check (length(teacher_name) between 1 and 200),
  image text,
  following boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, teacher_id)
);
create index on public.teacher_follows(teacher_id) where following;
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text unique not null check (length(endpoint) < 2048 and endpoint ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.push\.apple\.com)/[^[:space:]]+$'),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{87}=?$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{22}==?$' or auth ~ '^[A-Za-z0-9_-]{22}$'),
  device_name text not null default 'Browser' check (length(device_name) <= 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_test_at timestamptz
);
create index on public.push_subscriptions(user_id);
create table public.teacher_poll_state (
  teacher_id integer primary key,
  next_page integer not null default 1,
  initialized_at timestamptz,
  cycle_started_at timestamptz,
  last_completed_at timestamptz,
  retry_at timestamptz,
  last_error text
);
create table public.observed_shiurim (
  teacher_id integer not null references public.teacher_poll_state(teacher_id) on delete cascade,
  shiur_id integer not null,
  first_seen_at timestamptz not null default now(),
  primary key(teacher_id, shiur_id)
);
create table public.notification_deliveries (
  id bigint generated always as identity primary key,
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  teacher_id integer not null,
  shiur_id integer not null,
  payload jsonb not null,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique(subscription_id, teacher_id, shiur_id)
);
create index on public.notification_deliveries(next_attempt_at) where sent_at is null;
create table public.notification_worker (
  singleton boolean primary key default true check(singleton),
  lease_token uuid,
  lease_until timestamptz,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_result jsonb
);
insert into public.notification_worker(singleton) values(true);

alter table public.teacher_follows enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.teacher_poll_state enable row level security;
alter table public.observed_shiurim enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.notification_worker enable row level security;
revoke all on public.teacher_follows, public.push_subscriptions, public.teacher_poll_state, public.observed_shiurim, public.notification_deliveries, public.notification_worker from anon, authenticated;
grant select on public.teacher_follows, public.push_subscriptions to authenticated;
grant all on public.teacher_follows, public.push_subscriptions, public.teacher_poll_state, public.observed_shiurim, public.notification_deliveries, public.notification_worker to service_role;
grant usage, select on sequence public.notification_deliveries_id_seq to service_role;
create policy own_follows on public.teacher_follows for select to authenticated using ((select auth.uid()) = user_id);
create policy own_devices on public.push_subscriptions for select to authenticated using ((select auth.uid()) = user_id);

create function public.set_teacher_follow(p_teacher_id integer, p_teacher_name text, p_image text, p_following boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Sign in first'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text, 0));
  if p_following and not exists(select 1 from public.teacher_follows where user_id=uid and teacher_id=p_teacher_id and following)
    and (select count(*) from public.teacher_follows where user_id=uid and following) >= 100 then
    raise exception 'You can follow up to 100 teachers';
  end if;
  insert into public.teacher_follows(user_id,teacher_id,teacher_name,image,following)
    values(uid,p_teacher_id,p_teacher_name,left(p_image,2048),p_following)
    on conflict(user_id,teacher_id) do update set teacher_name=excluded.teacher_name,image=excluded.image,following=excluded.following,
      created_at=case when excluded.following and not public.teacher_follows.following then now() else public.teacher_follows.created_at end,updated_at=now();
  if p_following then insert into public.teacher_poll_state(teacher_id) values(p_teacher_id) on conflict do nothing; end if;
end $$;

create function public.register_push_subscription(p_endpoint text,p_p256dh text,p_auth text,p_device_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); result uuid;
begin
  if uid is null then raise exception 'Sign in first'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  if (select count(*) from public.push_subscriptions where user_id=uid and endpoint<>p_endpoint) >= 10 then raise exception 'Remove an old device before adding another'; end if;
  -- A browser endpoint is a capability, held only by this device. Reassign it
  -- when the device switches accounts, and discard the previous account's queue.
  delete from public.push_subscriptions where endpoint=p_endpoint and user_id<>uid;
  insert into public.push_subscriptions(user_id,endpoint,p256dh,auth,device_name)
    values(uid,p_endpoint,p_p256dh,p_auth,p_device_name)
    on conflict(endpoint) do update set p256dh=excluded.p256dh,auth=excluded.auth,device_name=excluded.device_name,updated_at=now()
    returning id into result;
  return result;
end $$;
create function public.remove_push_subscription(p_endpoint text)
returns void language sql security definer set search_path = '' as $$
  delete from public.push_subscriptions where user_id=auth.uid() and endpoint=p_endpoint;
$$;
create function public.queue_test_notification(p_subscription_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.push_subscriptions set last_test_at=now() where id=p_subscription_id and user_id=auth.uid()
    and (last_test_at is null or last_test_at < now()-interval '1 minute');
  if not found then raise exception 'Wait a minute before sending another test'; end if;
  insert into public.notification_deliveries(subscription_id,teacher_id,shiur_id,payload)
    values(p_subscription_id,0,-extract(epoch from clock_timestamp())::integer,
      jsonb_build_object('title','YUTorah notifications are on','body','You will hear when a teacher you follow posts a new shiur.','url','/?view=following','tag','yutorah-test'));
end $$;

create function public.claim_notification_worker(p_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.notification_worker set lease_token=p_token,lease_until=now()+interval '2 minutes',last_started_at=now()
    where singleton and (lease_until is null or lease_until < now());
  return found;
end $$;
create function public.record_teacher_shiurim(p_teacher_id integer,p_items jsonb,p_baseline boolean)
returns integer language plpgsql security definer set search_path = '' as $$
declare item jsonb; inserted integer; queued integer := 0; teacher_name text;
begin
  select f.teacher_name into teacher_name from public.teacher_follows f where f.teacher_id=p_teacher_id and following limit 1;
  for item in select value from jsonb_array_elements(p_items) loop
    insert into public.observed_shiurim(teacher_id,shiur_id) values(p_teacher_id,(item->>'id')::integer) on conflict do nothing;
    get diagnostics inserted = row_count;
    if inserted=1 and not p_baseline then
      insert into public.notification_deliveries(subscription_id,teacher_id,shiur_id,payload)
        select s.id,p_teacher_id,(item->>'id')::integer,
          jsonb_build_object('title',left(teacher_name,100)||' posted a shiur','body',left(item->>'title',250),'url','/?shiur='||(item->>'id'),'tag','shiur-'||(item->>'id'))
        from public.push_subscriptions s join public.teacher_follows f on f.user_id=s.user_id and f.teacher_id=p_teacher_id and f.following
        join public.teacher_poll_state t on t.teacher_id=p_teacher_id
        where f.created_at <= t.cycle_started_at and s.created_at <= t.cycle_started_at
        on conflict do nothing;
      get diagnostics inserted = row_count; queued := queued+inserted;
    end if;
  end loop;
  return queued;
end $$;

-- Public functions are explicitly separated from the server-only functions.
revoke all on function public.set_teacher_follow(integer,text,text,boolean),public.register_push_subscription(text,text,text,text),public.remove_push_subscription(text),public.queue_test_notification(uuid),public.claim_notification_worker(uuid),public.record_teacher_shiurim(integer,jsonb,boolean) from public, anon, authenticated;
grant execute on function public.set_teacher_follow(integer,text,text,boolean),public.register_push_subscription(text,text,text,text),public.remove_push_subscription(text),public.queue_test_notification(uuid) to authenticated;
grant execute on function public.claim_notification_worker(uuid),public.record_teacher_shiurim(integer,jsonb,boolean) to service_role;
