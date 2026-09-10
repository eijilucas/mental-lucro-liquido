-- ============================================================================
-- Gastos fixos passam a se repetir automaticamente todo mês, sem precisar
-- recadastrar. Regras:
--   - Todo mês (com venda) herda os gastos fixos do mês anterior.
--   - Editar o valor de um gasto fixo num mês propaga pra frente — todos
--     os meses seguintes que ainda não foram editados na mão (`manually_edited`).
--   - Meses anteriores ao editado NÃO mudam (histórico preservado).
--   - Apagar um gasto fixo apaga desse mês pra frente (o passado fica).
--
-- Marketing continua mês a mês, sem herança (campanha muda todo mês).
--
-- Nada disso mexe nas views de DRE (`sale_margin`, `monthly_dre`,
-- `sale_overhead_allocation`): a herança só materializa linhas em
-- `monthly_overhead`, que essas views já leem.
-- ============================================================================

alter table monthly_overhead add column if not exists manually_edited boolean not null default false;

-- Preenche os meses faltantes herdando do mês anterior. Idempotente:
-- só insere gasto fixo que ainda não existe naquele mês. Roda de novo
-- sem duplicar. Chamada no load do admin e por um cron diário.
create or replace function carry_forward_fixed_overhead()
returns void
language plpgsql
as $$
declare
  m date;
  cur_month date := date_trunc('month', now())::date;
  first_month date;
  ref_month date;
begin
  select min(month) into first_month from monthly_overhead where not is_marketing;
  if first_month is null then
    return;
  end if;

  m := first_month;
  while m <= cur_month loop
    -- último mês anterior a `m` que tem algum gasto fixo cadastrado
    select max(month) into ref_month
    from monthly_overhead
    where not is_marketing and month < m;

    if ref_month is not null then
      insert into monthly_overhead (month, category, amount, is_marketing, allocation_method, manually_edited)
      select m, ref.category, ref.amount, false, ref.allocation_method, false
      from monthly_overhead ref
      where ref.month = ref_month
        and not ref.is_marketing
        and not exists (
          select 1 from monthly_overhead x
          where x.month = m and not x.is_marketing and x.category = ref.category
        );
    end if;

    m := (m + interval '1 month')::date;
  end loop;
end;
$$;

grant execute on function carry_forward_fixed_overhead() to authenticated;

-- Backfill imediato do histórico já existente.
select carry_forward_fixed_overhead();

-- Roda todo dia às 5h UTC (2h Brasília) — garante que o mês corrente
-- sempre tenha os fixos, mesmo que ninguém abra o admin.
create extension if not exists pg_cron with schema extensions;

select cron.schedule(
  'carry-forward-fixed-overhead-daily',
  '0 5 * * *',
  $$ select carry_forward_fixed_overhead(); $$
)
where not exists (select 1 from cron.job where jobname = 'carry-forward-fixed-overhead-daily');
