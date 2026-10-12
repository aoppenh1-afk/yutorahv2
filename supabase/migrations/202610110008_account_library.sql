-- Private account library, independent of the notification tables and worker.
create table public.library_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 0,
  storage_bytes bigint not null default 0
);
create table public.library_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  value jsonb,
  deleted boolean not null default false,
  version bigint not null,
  operation uuid not null,
  updated_at timestamptz not null default now(),
  primary key(user_id,key)
);
create index library_items_changes on public.library_items(user_id,version);
alter table public.library_profiles enable row level security;
alter table public.library_items enable row level security;
create policy library_profile_owner on public.library_profiles for select to authenticated using (user_id=auth.uid());
create policy library_item_owner on public.library_items for select to authenticated using (user_id=auth.uid());
revoke all on public.library_profiles,public.library_items from anon,authenticated;
grant select on public.library_profiles,public.library_items to authenticated;
grant all on public.library_profiles,public.library_items to service_role;

create function public.sync_account_library(p_changes jsonb default '[]',p_since bigint default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid(); change jsonb; item_key text; item_value jsonb;
  item_deleted boolean; op uuid; base bigint; current public.library_items;
  rev bigint; used bigint; old_size bigint; new_size bigint;
  conflicts jsonb := '[]'; resolved jsonb := '[]'; items jsonb;
  next_rev bigint; more boolean;
begin
  if uid is null then raise exception 'Sign in to sync your library'; end if;
  if jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes)>250
    or p_since is null or p_since<0 then raise exception 'Invalid library sync request'; end if;
  perform pg_advisory_xact_lock(hashtextextended('library:'||uid::text,0));
  insert into public.library_profiles(user_id) values(uid) on conflict do nothing;
  select revision,storage_bytes into rev,used from public.library_profiles where user_id=uid for update;
  for change in select value from jsonb_array_elements(p_changes) loop
    item_key := change->>'key'; item_deleted := (change->>'deleted')::boolean;
    op := (change->>'operation')::uuid; base := (change->>'base_version')::bigint;
    item_value := case when item_deleted then null else change->'value' end;
    if item_key is null or length(item_key)>180 or item_key !~ '^(queue|last|((recording|saved|history|playlist|playlist-item|note|follow|hidden|completed|search|day|preference):[A-Za-z0-9:_-]+))$'
      or item_deleted is null or op is null or base is null or base<0
      or (not item_deleted and (item_value is null or octet_length(item_value::text)>65536)) then
      raise exception 'This library item cannot be synced. It remains on this device';
    end if;
    if not item_deleted then
      if item_key like 'recording:%' and (jsonb_typeof(item_value) is distinct from 'object' or jsonb_typeof(item_value->'title') is distinct from 'string' or jsonb_typeof(item_value->'topics') is distinct from 'array') then raise exception 'Invalid recording'; end if;
      if item_key ~ '^(saved|history|playlist|playlist-item|note|follow|search):' and jsonb_typeof(item_value) is distinct from 'object' then raise exception 'Invalid library item'; end if;
      if item_key='queue' and (jsonb_typeof(item_value) is distinct from 'array' or jsonb_array_length(item_value)>1000) then raise exception 'Invalid queue'; end if;
      if item_key like 'day:%' and (item_key !~ '^day:[0-9]{4}-[0-9]{2}-[0-9]{2}:([a-f0-9-]{36}|legacy)$' or jsonb_typeof(item_value) is distinct from 'number' or (item_value::text)::numeric<0 or (item_value::text)::numeric>31536000) then raise exception 'Invalid learning time'; end if;
      if item_key like 'preference:%' and (
        (item_key in ('preference:speed','preference:defaultSpeed') and item_value::text not in ('0.75','1','1.25','1.5','1.75','2','2.25','2.5','2.75','3'))
        or (item_key='preference:volume' and (jsonb_typeof(item_value) is distinct from 'number' or (item_value::text)::numeric<0 or (item_value::text)::numeric>1))
        or (item_key='preference:dailyGoal' and item_value::text not in ('5','10','15','20','30','45','60'))
        or item_key not in ('preference:speed','preference:defaultSpeed','preference:volume','preference:dailyGoal')) then raise exception 'Invalid playback or learning preference'; end if;
    end if;
    select * into current from public.library_items where user_id=uid and key=item_key;
    if current.operation=op then
      -- A response may be lost after commit. The same operation is an acknowledgement.
      null;
    elsif item_key like 'day:%' and not item_deleted and coalesce((current.value::text)::numeric,0)>=(item_value::text)::numeric then
      null;
    elsif item_key not like 'day:%' and coalesce(current.version,0)<>base then
      -- Preserve a newer edit or deletion made on another device.
      conflicts := conflicts || jsonb_build_array(item_key);
    else
      old_size := case when current.key is null then 0 else octet_length(coalesce(current.value::text,''))+octet_length(current.key)+160 end;
      new_size := octet_length(coalesce(item_value::text,''))+octet_length(item_key)+160;
      if used-old_size+new_size > 10485760 then raise exception 'Your cloud library has reached its storage limit. Your changes remain on this device'; end if;
      used := used-old_size+new_size; rev := rev+1;
      insert into public.library_items(user_id,key,value,deleted,version,operation)
        values(uid,item_key,item_value,item_deleted,rev,op)
        on conflict(user_id,key) do update set value=excluded.value,deleted=excluded.deleted,version=excluded.version,operation=excluded.operation,updated_at=now();
    end if;
    select * into current from public.library_items where user_id=uid and key=item_key;
    if current.key is not null then resolved := resolved || jsonb_build_array(jsonb_build_object('key',current.key,'value',current.value,'deleted',current.deleted,'version',current.version,'operation',current.operation)); end if;
  end loop;
  update public.library_profiles set revision=rev,storage_bytes=used where user_id=uid and (revision<>rev or storage_bytes<>used);
  select coalesce(jsonb_agg(jsonb_build_object('key',s.key,'value',s.value,'deleted',s.deleted,'version',s.version,'operation',s.operation) order by s.version),'[]'),coalesce(max(s.version),p_since)
    into items,next_rev from (select * from public.library_items where user_id=uid and version>p_since order by version limit 1000) s;
  more := exists(select 1 from public.library_items where user_id=uid and version>next_rev);
  return jsonb_build_object('items',items,'resolved',resolved,'revision',case when more then next_rev else rev end,'has_more',more,'conflicts',conflicts);
end $$;
revoke all on function public.sync_account_library(jsonb,bigint) from public,anon;
grant execute on function public.sync_account_library(jsonb,bigint) to authenticated;
