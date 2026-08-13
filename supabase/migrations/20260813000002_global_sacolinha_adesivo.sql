-- ============================================================================
-- Sacolinha e adesivo custam o mesmo pra toda peça — não faz sentido
-- digitar o mesmo valor peça por peça. Viram 2 campos únicos em
-- sale_fee_rates (a mesma tabela/tela "Taxas de venda"), aplicados
-- automaticamente no cálculo de custo direto de TODA peça.
-- ============================================================================

alter table sale_fee_rates add column if not exists sacolinha numeric(10,2) not null default 0;
alter table sale_fee_rates add column if not exists adesivo numeric(10,2) not null default 0;

drop view if exists monthly_dre;
drop view if exists sale_margin;

alter table product_costs drop column if exists sacolinha;
alter table product_costs drop column if exists adesivo;

create or replace view sale_margin as
select
  sr.shopify_order_id as sale_id,
  sr.product_sku,
  sr.product_name,
  sr.quantity,
  sr.gross_amount,
  sr.sale_date,
  (coalesce(pc.tecido, 0) + coalesce(pc.estampa, 0) + coalesce(pc.costura, 0)
    + coalesce(fr.sacolinha, 0) + coalesce(fr.adesivo, 0) + coalesce(pc.outros_acabamentos, 0)) * sr.quantity
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
        + coalesce(fr.sacolinha, 0) + coalesce(fr.adesivo, 0) + coalesce(pc.outros_acabamentos, 0)) * sr.quantity
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
