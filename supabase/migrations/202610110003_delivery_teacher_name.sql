-- Avoid a PL/pgSQL variable collision with teacher_follows.teacher_name.
create or replace function public.record_teacher_shiurim(p_teacher_id integer,p_items jsonb,p_baseline boolean)
returns integer language plpgsql security definer set search_path = '' as $$
declare item jsonb; inserted integer; queued integer := 0; display_teacher_name text;
begin
  select f.teacher_name into display_teacher_name from public.teacher_follows f where f.teacher_id=p_teacher_id and following limit 1;
  for item in select value from jsonb_array_elements(p_items) loop
    insert into public.observed_shiurim(teacher_id,shiur_id) values(p_teacher_id,(item->>'id')::integer) on conflict do nothing;
    get diagnostics inserted = row_count;
    if inserted=1 and not p_baseline then
      insert into public.notification_deliveries(subscription_id,teacher_id,shiur_id,payload)
        select s.id,p_teacher_id,(item->>'id')::integer,
          jsonb_build_object('title',left(display_teacher_name,100)||' posted a shiur','body',left(item->>'title',250),'url','/?shiur='||(item->>'id'),'tag','shiur-'||(item->>'id'))
        from public.push_subscriptions s join public.teacher_follows f on f.user_id=s.user_id and f.teacher_id=p_teacher_id and f.following
        join public.teacher_poll_state t on t.teacher_id=p_teacher_id
        where f.created_at <= t.cycle_started_at and s.created_at <= t.cycle_started_at
        on conflict do nothing;
      get diagnostics inserted = row_count; queued := queued+inserted;
    end if;
  end loop;
  return queued;
end $$;
