-- Following and receiving alerts are independent account preferences.
alter table public.teacher_follows
  add column notifications_enabled boolean not null default true;

-- Keep the four-argument call working for older clients.
drop function public.set_teacher_follow(integer, text, text, boolean);
create function public.set_teacher_follow(
  p_teacher_id integer, p_teacher_name text, p_image text, p_following boolean,
  p_notifications_enabled boolean default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Sign in first'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text, 0));
  if p_following and not exists(select 1 from public.teacher_follows where user_id=uid and teacher_id=p_teacher_id and following)
    and (select count(*) from public.teacher_follows where user_id=uid and following) >= 100 then
    raise exception 'You can follow up to 100 teachers';
  end if;
  insert into public.teacher_follows(user_id,teacher_id,teacher_name,image,following,notifications_enabled)
    values(uid,p_teacher_id,p_teacher_name,left(p_image,2048),p_following,coalesce(p_notifications_enabled,true))
    on conflict(user_id,teacher_id) do update set teacher_name=excluded.teacher_name,image=excluded.image,following=excluded.following,
      notifications_enabled=coalesce(p_notifications_enabled,public.teacher_follows.notifications_enabled),
      created_at=case when excluded.following and not public.teacher_follows.following then now() else public.teacher_follows.created_at end,updated_at=now();
  if p_following then insert into public.teacher_poll_state(teacher_id) values(p_teacher_id) on conflict do nothing; end if;
  if not p_following or p_notifications_enabled=false then
    delete from public.notification_deliveries d using public.push_subscriptions s
      where d.subscription_id=s.id and s.user_id=uid and d.teacher_id=p_teacher_id and d.sent_at is null;
  end if;
end $$;
revoke all on function public.set_teacher_follow(integer,text,text,boolean,boolean) from public,anon;
grant execute on function public.set_teacher_follow(integer,text,text,boolean,boolean) to authenticated;

-- Only queue alerts for teachers the recipient has enabled.
create or replace function public.record_teacher_shiurim(p_teacher_id integer,p_items jsonb,p_baseline boolean)
returns integer language plpgsql security definer set search_path = '' as $$
declare item jsonb; inserted integer; queued integer := 0;
begin
  for item in select value from jsonb_array_elements(p_items) loop
    insert into public.observed_shiurim(teacher_id,shiur_id) values(p_teacher_id,(item->>'id')::integer) on conflict do nothing;
    get diagnostics inserted = row_count;
    if inserted=1 and not p_baseline then
      insert into public.notification_deliveries(subscription_id,teacher_id,shiur_id,payload)
        select s.id,p_teacher_id,(item->>'id')::integer,
          jsonb_build_object('title',left(f.teacher_name,100)||' posted a shiur','body',left(item->>'title',250),'url','/?shiur='||(item->>'id'),'tag','shiur-'||(item->>'id'))
        from public.push_subscriptions s join public.teacher_follows f on f.user_id=s.user_id and f.teacher_id=p_teacher_id and f.following and f.notifications_enabled
        join public.teacher_poll_state t on t.teacher_id=p_teacher_id
        where f.created_at <= t.last_completed_at and s.created_at <= t.last_completed_at
        on conflict do nothing;
      get diagnostics inserted = row_count; queued := queued+inserted;
    end if;
  end loop;
  return queued;
end $$;
