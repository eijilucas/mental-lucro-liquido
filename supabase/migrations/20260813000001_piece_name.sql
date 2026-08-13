-- ============================================================================
-- Adiciona "piece_name" (nome da peça sem tamanho, vindo de
-- product_costs.product_name) na view sale_margin — sr.product_name
-- inclui o tamanho da variante (ex: "Camiseta Regular - P"), o que fazia
-- "Lucro por peça" mostrar P, M, G como peças diferentes em vez de
-- agrupar tudo numa linha só.
-- ============================================================================

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
  coalesce(pc.product_line, 'basico') as product_line,
  coalesce(pc.product_name, sr.product_name) as piece_name
from sale_revenue sr
left join product_costs pc on pc.shopify_product_id = sr.shopify_product_id
left join sale_overhead_allocation oa on oa.sale_id = sr.shopify_order_id and oa.shopify_line_item_id = sr.shopify_line_item_id
cross join sale_fee_rates fr
where fr.id = 1;
