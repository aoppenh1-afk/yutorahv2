create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create function public.next_teacher_poll()
returns setof public.teacher_poll_state language plpgsql security definer set search_path = '' as $$
declare selected integer;
begin
  select t.teacher_id into selected from public.teacher_poll_state t
  where exists(select 1 from public.teacher_follows f where f.teacher_id=t.teacher_id and f.following)
    and (t.retry_at is null or t.retry_at<=now())
    and (t.cycle_started_at is not null or t.last_completed_at is null or t.last_completed_at<=now()-interval '6 hours')
  order by t.cycle_started_at nulls first,t.last_completed_at nulls first,t.teacher_id limit 1 for update skip locked;
  if selected is null then return; end if;
  update public.teacher_poll_state set cycle_started_at=coalesce(cycle_started_at,now()) where teacher_id=selected;
  return query select * from public.teacher_poll_state where teacher_id=selected;
end $$;
create function public.dispatch_notification_worker()
returns bigint language plpgsql security definer set search_path = '' as $$
declare project_url text; secret text; request_id bigint;
begin
  select decrypted_secret into project_url from vault.decrypted_secrets where name='notification_project_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name='notification_cron_secret';
  if project_url is null or secret is null then raise exception 'Notification scheduler secrets are missing'; end if;
  select net.http_post(url:=project_url||'/functions/v1/notify-shiurim',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',secret),body:='{}'::jsonb,timeout_milliseconds:=10000) into request_id;
  return request_id;
end $$;
revoke all on function public.next_teacher_poll(),public.dispatch_notification_worker() from public,anon,authenticated;
grant execute on function public.next_teacher_poll(),public.dispatch_notification_worker() to service_role;
select cron.schedule('yutorah-notifications-every-six-hours','0 */6 * * *','select public.dispatch_notification_worker()');
