-- ============================================================================
-- Terceiro método de rateio: 'fixed_per_unit' (CAC fixo).
-- Diferente de 'per_unit' (que divide o pool do mês pelas peças vendidas),
-- aqui o valor digitado já É o custo por peça — aplicado direto em cada
-- venda, sem depender de quantas peças o mês teve no total. Útil quando
-- você já sabe o CAC de uma campanha (gasto ÷ conversões) e quer aplicar
-- esse número direto, em vez de ratear um pool.
-- ============================================================================

alter table monthly_overhead drop constraint monthly_overhead_allocation_method_check;
alter table monthly_overhead add constraint monthly_overhead_allocation_method_check
  check (allocation_method in ('per_unit', 'per_revenue', 'fixed_per_unit'));

create or replace view sale_overhead_allocation as
select
  sr.sale_id,
  sr.product_sku,
  coalesce(sum(
    case
      when mo.allocation_method = 'per_unit' then mo.amount * sr.quantity / nullif(mt.units, 0)
      when mo.allocation_method = 'fixed_per_unit' then mo.amount * sr.quantity
      else mo.amount * sr.gross_amount / nullif(mt.revenue, 0)
    end
  ) filter (where mo.is_marketing), 0) as marketing_cost,
  coalesce(sum(
    case
      when mo.allocation_method = 'per_unit' then mo.amount * sr.quantity / nullif(mt.units, 0)
      when mo.allocation_method = 'fixed_per_unit' then mo.amount * sr.quantity
      else mo.amount * sr.gross_amount / nullif(mt.revenue, 0)
    end
  ) filter (where not mo.is_marketing), 0) as fixed_cost
from sale_revenue sr
join monthly_totals mt on mt.month = date_trunc('month', sr.sale_date)::date
left join monthly_overhead mo on mo.month = mt.month
group by sr.sale_id, sr.product_sku;
