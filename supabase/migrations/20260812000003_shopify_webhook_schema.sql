-- ============================================================================
-- Reestrutura sale_revenue pra receber dados direto de um webhook da
-- Shopify (orders/paid, orders/cancelled, refunds/create), em vez de
-- sincronizar do Projeto A.
--
-- Motivo da mudança de rumo: o Projeto A só enxerga vendas com cupom de
-- afiliado (é o dado que ele existe pra rastrear) — o Vitor precisa do
-- lucro de TODAS as vendas, com ou sem cupom. E como o payload da
-- Shopify já vem com SKU e preço por item, nem precisamos resolver a
-- pendência de sale_items não ter esses campos no Projeto A.
--
-- sale_id (uuid solto, sem significado fora do sync antigo) vira
-- shopify_order_id + shopify_line_item_id — os identificadores reais
-- que a Shopify manda, e que servem de chave pra idempotência (a
-- Shopify pode reenviar o mesmo webhook mais de uma vez) e pra
-- localizar a linha certa quando chega um reembolso ou cancelamento.
--
-- sale_margin e sale_overhead_allocation continuam expondo a coluna
-- como "sale_id" (só troca o que alimenta ela por baixo) — dashboard e
-- admin não precisam mudar uma linha de código por causa disso.
-- ============================================================================

-- Só tem dado de exemplo (seed) até aqui — sem venda real ainda, então
-- não tem nada de produção pra perder.
truncate table sale_revenue;

-- monthly_dre depende de sale_margin, que depende de sale_revenue e de
-- sale_overhead_allocation — precisa derrubar as views antes de mexer
-- na coluna, e recriar todas depois (nessa ordem de dependência).
drop view monthly_dre;
drop view sale_margin;
drop view sale_overhead_allocation;

alter table sale_revenue drop constraint sale_revenue_pkey;
alter table sale_revenue drop column sale_id;
alter table sale_revenue add column shopify_order_id bigint not null;
alter table sale_revenue add column shopify_line_item_id bigint not null;
alter table sale_revenue add primary key (shopify_order_id, shopify_line_item_id);

create index if not exists idx_sale_revenue_order on sale_revenue (shopify_order_id);

create or replace view sale_overhead_allocation as
select
  sr.shopify_order_id as sale_id,
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
group by sr.shopify_order_id, sr.product_sku;

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
  , 2) as net_profit
from sale_revenue sr
left join product_costs pc on pc.sku = sr.product_sku
left join sale_overhead_allocation oa on oa.sale_id = sr.shopify_order_id and oa.product_sku = sr.product_sku
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
