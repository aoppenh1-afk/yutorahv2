-- Catalog follows live in the existing private account library. Keep its
-- owner RLS, versioned RPC, offline retries and unfollow tombstones unchanged.
create function public.validate_library_follow()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.key not like 'follow:%' then return new; end if;
  if new.key !~ '^follow:(topic|series|venue|collection):[1-9][0-9]{0,15}$' then
    raise exception 'Invalid library follow';
  end if;
  if split_part(new.key, ':', 3)::numeric > 9007199254740991 then raise exception 'Invalid library follow'; end if;
  if not new.deleted and (
    jsonb_typeof(new.value) is distinct from 'object'
    or jsonb_typeof(new.value->'id') is distinct from 'number'
    or new.key is distinct from 'follow:'||(new.value->>'kind')||':'||(new.value->>'id')
    or (new.value->>'id')::numeric > 9007199254740991
    or jsonb_typeof(new.value->'name') is distinct from 'string'
    or length(btrim(new.value->>'name')) not between 1 and 300
    or (new.value ? 'image' and (jsonb_typeof(new.value->'image') is distinct from 'string' or length(new.value->>'image')>2048))
  ) then raise exception 'Invalid library follow'; end if;
  return new;
end $$;
revoke all on function public.validate_library_follow() from public,anon,authenticated;
create trigger library_follow_validation before insert or update on public.library_items
for each row execute function public.validate_library_follow();
