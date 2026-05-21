create or replace function public.is_operator_co_assigned(_operator_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.character_operator_assignments mine
    join public.character_operator_assignments theirs
      on theirs.character_id = mine.character_id
    join public.operators me
      on me.id = mine.operator_id
    where mine.operator_id = public.get_my_operator_id()
      and theirs.operator_id = _operator_id
      and me.is_active = true
  );
$$;

drop policy if exists "Operators view co-assigned operators" on public.operators;
create policy "Operators view co-assigned operators"
on public.operators
for select
using (
  public.is_operator()
  and public.is_operator_co_assigned(id)
);
