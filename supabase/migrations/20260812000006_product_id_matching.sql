-- ============================================================================
-- Troca a granularidade de custo de "por variante" (P/M/G viravam linhas
-- separadas, mesmo nome repetido 3x) pra "por peça" (produto inteiro na
-- Shopify) — custo de tecido/estampa/costura é o mesmo em qualquer
-- tamanho, então uma linha só por peça faz mais sentido pro admin
-- preencher, e elimina a repetição visual na tela.
--
-- Sem venda real registrada ainda (confirmado via select count(*)), então
-- não tem nada de produção pra perder.
-- ============================================================================

drop view monthly_dre;
drop view sale_margin;

truncate table product_costs;
truncate table sale_revenue;

alter table product_costs drop constraint product_costs_variant_id_key;
alter table product_costs rename column shopify_variant_id to shopify_product_id;
alter table product_costs add constraint product_costs_product_id_key unique (shopify_product_id);

alter table sale_revenue rename column shopify_variant_id to shopify_product_id;

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
left join product_costs pc on pc.shopify_product_id = sr.shopify_product_id
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
