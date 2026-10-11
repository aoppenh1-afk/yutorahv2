-- Poll once per UTC hour. A scan finishing after the hour must not skip
-- the next scheduled run simply because fewer than 60 minutes have elapsed.
create or replace function public.next_teacher_poll()
returns setof public.teacher_poll_state language plpgsql security definer set search_path = '' as $$
declare selected integer;
begin
  select t.teacher_id into selected from public.teacher_poll_state t
  where exists(select 1 from public.teacher_follows f where f.teacher_id=t.teacher_id and f.following)
    and (t.retry_at is null or t.retry_at<=now())
    and (t.cycle_started_at is not null or t.last_completed_at is null or t.last_completed_at<date_trunc('hour',now(),'UTC'))
  order by t.cycle_started_at nulls first,t.last_completed_at nulls first,t.teacher_id limit 1 for update skip locked;
  if selected is null then return; end if;
  update public.teacher_poll_state set cycle_started_at=coalesce(cycle_started_at,now()) where teacher_id=selected;
  return query select * from public.teacher_poll_state where teacher_id=selected;
end $$;

do $$ declare old_job bigint;
begin
  for old_job in select jobid from cron.job where jobname='yutorah-notifications-every-six-hours' loop
    perform cron.unschedule(old_job);
  end loop;
end $$;
select cron.schedule('yutorah-notifications-hourly','0 * * * *','select public.dispatch_notification_worker()');
