-- ============================================================================
-- Troca a chave de casamento peça <-> venda de SKU pra shopify_variant_id.
--
-- Motivo: descobrimos que nenhum produto da loja tem SKU cadastrado na
-- Shopify (todas as variantes vêm com "sku": null da API). Como o SKU era
-- a chave usada tanto pra importar o catálogo quanto pro webhook casar
-- uma venda com o custo da peça, nenhuma venda seria registrada do jeito
-- que estava. shopify_variant_id sempre existe (é gerado pela própria
-- Shopify), então vira a chave real; SKU passa a ser só um campo
-- informativo, editável, sem função no matching.
--
-- Sem dado de produção até aqui (product_costs e sale_revenue foram
-- zerados a pedido), então não tem nada pra migrar de verdade.
-- ============================================================================

drop view monthly_dre;
drop view sale_margin;
drop view sale_overhead_allocation;

truncate table product_costs;
truncate table sale_revenue;

alter table product_costs drop constraint product_costs_pkey;
alter table product_costs add column id uuid primary key default gen_random_uuid();
alter table product_costs add column shopify_variant_id bigint;
alter table product_costs alter column sku drop not null;
-- unique "de verdade" (não parcial): PostgREST monta o ON CONFLICT sem
-- predicado WHERE, então precisa ser uma constraint plana pro upsert do
-- import funcionar. NULL não conflita com NULL em unique constraint no
-- Postgres, então peças cadastradas manualmente (sem variant_id) continuam
-- podendo coexistir sem problema.
alter table product_costs add constraint product_costs_variant_id_key unique (shopify_variant_id);

alter table sale_revenue add column shopify_variant_id bigint;
alter table sale_revenue alter column product_sku drop not null;
create index if not exists idx_sale_revenue_variant_id on sale_revenue (shopify_variant_id);

create or replace view sale_overhead_allocation as
select
  sr.shopify_order_id as sale_id,
  sr.shopify_line_item_id,
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
group by sr.shopify_order_id, sr.shopify_line_item_id;

create or replace view sale_margin as
select
  sr.shopify_order_id as sale_id,
  sr.product_sku,
  sr.product_name,
  sr.quantity,
  sr.gross_amount,
  sr.sale_date,
  (coalesce(pc.tecido, 0) + coalesce(pc.estampa, 0) + coalesce(pc.costura, 0)
    + coalesce(pc.sacolinha, 0) + coalesce(pc.adesivo, 0) + coalesce(pc.outros_acabamentos, 0)) * sr.quantity
    as direct_cost,
  round(sr.gross_amount * (
    fr.taxa_shopify_pct + fr.taxa_gateway_pct + fr.imposto_pct
    + fr.comissao_influencer_pct + fr.desconto_medio_pct
  ), 2) as sale_cost,
  round(coalesce(oa.marketing_cost, 0), 2) as marketing_cost,
  round(coalesce(oa.fixed_cost, 0), 2) as fixed_cost,
  round(
    sr.gross_amount
    - (coalesce(pc.tecido, 0) + coalesce(pc.estampa, 0) + coalesce(pc.costura, 0)
        + coalesce(pc.sacolinha, 0) + coalesce(pc.adesivo, 0) + coalesce(pc.outros_acabamentos, 0)) * sr.quantity
    - sr.gross_amount * (
        fr.taxa_shopify_pct + fr.taxa_gateway_pct + fr.imposto_pct
        + fr.comissao_influencer_pct + fr.desconto_medio_pct
      )
    - coalesce(oa.marketing_cost, 0)
    - coalesce(oa.fixed_cost, 0)
  , 2) as net_profit,
  coalesce(pc.product_line, 'basico') as product_line
from sale_revenue sr
left join product_costs pc on pc.shopify_variant_id = sr.shopify_variant_id
left join sale_overhead_allocation oa on oa.sale_id = sr.shopify_order_id and oa.shopify_line_item_id = sr.shopify_line_item_id
cross join sale_fee_rates fr
where fr.id = 1;

create or replace view monthly_dre as
select
  date_trunc('month', sale_date)::date as month,
  sum(gross_amount) as gross_revenue,
  sum(direct_cost) as direct_cost,
  sum(sale_cost) as sale_cost,
  sum(marketing_cost) as marketing_cost,
  sum(fixed_cost) as fixed_cost,
  sum(net_profit) as net_profit
from sale_margin
group by 1;
