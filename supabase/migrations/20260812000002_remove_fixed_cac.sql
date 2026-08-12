-- ============================================================================
-- Reverte o método 'fixed_per_unit' (CAC fixo) — decisão do cliente: não dá
-- pra atribuir CAC por peça de forma confiável, porque um cliente pode
-- clicar no anúncio de uma peça e comprar outras junto. Fica só com os
-- dois métodos que fazem sentido sem esse tipo de rastreio: fixo (por
-- peça) e variável (por venda).
-- ============================================================================

-- Nenhuma linha usa 'fixed_per_unit' hoje — checagem de segurança antes de
-- apertar a constraint de volta.
do $$
begin
  if exists (select 1 from monthly_overhead where allocation_method = 'fixed_per_unit') then
    raise exception 'Existem linhas usando fixed_per_unit — migração abortada';
  end if;
end $$;

alter table monthly_overhead drop constraint monthly_overhead_allocation_method_check;
alter table monthly_overhead add constraint monthly_overhead_allocation_method_check
  check (allocation_method in ('per_unit', 'per_revenue'));

create or replace view sale_overhead_allocation as
select
  sr.sale_id,
  sr.product_sku,
  coalesce(sum(
    case when mo.allocation_method = 'per_unit' then mo.amount * sr.quantity / nullif(mt.units, 0)
         else mo.amount * sr.gross_amount / nullif(mt.revenue, 0)
    end
  ) filter (where mo.is_marketing), 0) as marketing_cost,
  coalesce(sum(
    case when mo.allocation_method = 'per_unit' then mo.amount * sr.quantity / nullif(mt.units, 0)
         else mo.amount * sr.gross_amount / nullif(mt.revenue, 0)
    end
  ) filter (where not mo.is_marketing), 0) as fixed_cost
from sale_revenue sr
join monthly_totals mt on mt.month = date_trunc('month', sr.sale_date)::date
left join monthly_overhead mo on mo.month = mt.month
group by sr.sale_id, sr.product_sku;
