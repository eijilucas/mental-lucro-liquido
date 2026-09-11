-- ============================================================================
-- Comissão de influencer só quando teve cupom — nas duas origens.
--
-- Antes: `case when sr.source = 'external' and not sr.has_coupon then 0 else 1 end`
-- cobrava a comissão em TODA venda da Shopify, com ou sem cupom (só a venda
-- externa respeitava o has_coupon). A comissão só é devida quando o influencer
-- traz a venda pelo cupom dele, e o has_coupon já vem gravado certo pros dois
-- lados (shopify-webhook lê order.discount_codes) — então agora é o mesmo
-- critério pra todo mundo.
--
-- Efeito: pedido da Shopify sem cupom deixa de pagar comissao_influencer_pct
-- (5% por padrão) — sale_cost cai e net_profit sobe nesses pedidos.
-- ============================================================================

begin;

drop view if exists monthly_dre;
drop view if exists sale_margin;

create view sale_margin as
select
  coalesce(sr.shopify_order_id::text, sr.external_order_id::text) as sale_id,
  sr.product_sku,
  sr.product_name,
  sr.quantity,
  sr.gross_amount,
  sr.sale_date,
  (
    coalesce(pc.tecido, 0::numeric) + coalesce(pc.estampa, 0::numeric) + coalesce(pc.costura, 0::numeric)
    + coalesce(base.sacolinha, 0::numeric) + coalesce(base.adesivo, 0::numeric)
    + coalesce(pc.outros_acabamentos, 0::numeric)
  ) * sr.quantity::numeric as direct_cost,
  round(
    sr.gross_amount * (
      fr.taxa_shopify_pct
      + case when sr.payment_method = 'pix' then fr.taxa_gateway_pix_pct else fr.taxa_gateway_cartao_pct end
      + fr.imposto_pct
      + fr.comissao_influencer_pct * case when sr.has_coupon then 1 else 0 end
      + fr.desconto_medio_pct
    )
    + (case when sr.payment_method = 'pix' then fr.taxa_gateway_pix_fixo else fr.taxa_antifraude_fixo end
       * sr.gross_amount) / nullif(ot.order_gross, 0::numeric)
  , 2) as sale_cost,
  round(coalesce(oa.marketing_cost, 0::numeric), 2) as marketing_cost,
  round(coalesce(oa.fixed_cost, 0::numeric), 2) as fixed_cost,
  round(
    case when sr.source = 'external' then 0::numeric else coalesce(os.revenue, 0::numeric) end
      * sr.gross_amount / nullif(ot.order_gross, 0::numeric)
  , 2) as shipping_revenue,
  round(
    case when sr.source = 'external' then 0::numeric
         else coalesce(os.cost, base.taxa_frete_estimado) end
      * sr.gross_amount / nullif(ot.order_gross, 0::numeric)
  , 2) as shipping_cost,
  round(
    case when sr.source = 'external' then 0::numeric else coalesce(os.cost_adjustment, 0::numeric) end
      * sr.gross_amount / nullif(ot.order_gross, 0::numeric)
  , 2) as shipping_adjustment,
  round(
    sr.gross_amount
    - (
        (
          coalesce(pc.tecido, 0::numeric) + coalesce(pc.estampa, 0::numeric) + coalesce(pc.costura, 0::numeric)
          + coalesce(base.sacolinha, 0::numeric) + coalesce(base.adesivo, 0::numeric)
          + coalesce(pc.outros_acabamentos, 0::numeric)
        ) * sr.quantity::numeric
      )
    - (
        sr.gross_amount * (
          fr.taxa_shopify_pct
          + case when sr.payment_method = 'pix' then fr.taxa_gateway_pix_pct else fr.taxa_gateway_cartao_pct end
          + fr.imposto_pct
          + fr.comissao_influencer_pct * case when sr.has_coupon then 1 else 0 end
          + fr.desconto_medio_pct
        )
        + (case when sr.payment_method = 'pix' then fr.taxa_gateway_pix_fixo else fr.taxa_antifraude_fixo end
           * sr.gross_amount) / nullif(ot.order_gross, 0::numeric)
      )
    - coalesce(oa.marketing_cost, 0::numeric)
    - coalesce(oa.fixed_cost, 0::numeric)
    + case when sr.source = 'external' then 0::numeric else coalesce(os.revenue, 0::numeric) end
        * sr.gross_amount / nullif(ot.order_gross, 0::numeric)
    - case when sr.source = 'external' then 0::numeric
           else coalesce(os.cost, base.taxa_frete_estimado) end
        * sr.gross_amount / nullif(ot.order_gross, 0::numeric)
    - case when sr.source = 'external' then 0::numeric else coalesce(os.cost_adjustment, 0::numeric) end
        * sr.gross_amount / nullif(ot.order_gross, 0::numeric)
  , 2) as net_profit,
  coalesce(pc.product_line, 'basico') as product_line,
  coalesce(pc.product_name, sr.product_name) as piece_name,
  sr.has_coupon,
  sr.payment_method,
  sr.source
from sale_revenue sr
left join product_costs pc on pc.shopify_product_id = sr.shopify_product_id
left join sale_overhead_allocation oa
  on oa.sale_key = coalesce(sr.shopify_order_id::text, sr.external_order_id::text)
  and oa.line_key = coalesce(sr.shopify_line_item_id::text, sr.external_item_id::text)
left join (
  select coalesce(shopify_order_id::text, external_order_id::text) as order_key,
         sum(gross_amount) as order_gross
  from sale_revenue
  group by 1
) ot on ot.order_key = coalesce(sr.shopify_order_id::text, sr.external_order_id::text)
left join order_shipping os on os.shopify_order_id = sr.shopify_order_id
join sale_fee_rates fr on fr.id = case when sr.source = 'external' then 2 else 1 end
join sale_fee_rates base on base.id = 1;

alter view sale_margin set (security_invoker = true);

create view monthly_dre as
select
  (date_trunc('month', sale_date))::date as month,
  sum(gross_amount) as gross_revenue,
  sum(direct_cost) as direct_cost,
  sum(sale_cost) as sale_cost,
  sum(marketing_cost) as marketing_cost,
  sum(fixed_cost) as fixed_cost,
  sum(shipping_revenue) as shipping_revenue,
  sum(shipping_cost) as shipping_cost,
  sum(shipping_adjustment) as shipping_adjustment,
  sum(net_profit) as net_profit
from sale_margin
group by 1;

alter view monthly_dre set (security_invoker = true);

commit;
