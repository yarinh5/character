revoke all on function public.is_operator_co_assigned(uuid) from public;
revoke all on function public.is_operator_co_assigned(uuid) from anon;
grant execute on function public.is_operator_co_assigned(uuid) to authenticated;
