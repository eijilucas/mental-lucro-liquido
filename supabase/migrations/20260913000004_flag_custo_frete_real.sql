-- ============================================================================
-- Expõe se o custo de frete da linha é REAL (a etiqueta foi comprada e o
-- mm-etiquetas empurrou o valor) ou se é só o fallback estimado.
--
-- Contexto: taxa_frete_estimado está em 0, então pedido sem etiqueta comprada
-- entra na DRE cobrando frete do cliente e pagando zero — resultado de frete
-- inflado sem nenhum aviso na tela. 376 dos 621 pedidos estão nessa situação
-- (julho inteiro, 60% de agosto). Enquanto o custo real não chega, a tela
-- precisa dizer quantos pedidos estão sem ele, em vez de mostrar um número
-- que parece completo.
-- ============================================================================

begin;

drop view if exists monthly_dre;
drop view if exists sale_margin;

create view sale_margin as
with order_totals as (
  select
    coalesce(shopify_order_id::text, external_order_id::text) as order_key,
    sum(gross_amount - discount_amount) as order_net
  from sale_revenue
  group by 1
),
components as (
  select
    coalesce(sr.shopify_order_id::text, sr.external_order_id::text) as sale_id,
    sr.product_sku,
    sr.product_name,
    sr.quantity,
    (sr.gross_amount - sr.discount_amount) as gross_amount,
    sr.discount_amount,
    sr.sale_date,
    (
      coalesce(pc.tecido, 0::numeric) + coalesce(pc.estampa, 0::numeric) + coalesce(pc.costura, 0::numeric)
      + coalesce(base.sacolinha, 0::numeric) + coalesce(base.adesivo, 0::numeric)
      + coalesce(pc.outros_acabamentos, 0::numeric)
    ) * sr.quantity::numeric as direct_cost,
    -- coalesce externo: pedido inteiro zerado (brinde, 100% de cupom) faz
    -- order_net = 0, o rateio vira NULL e contaminaria o lucro. Nesse caso o
    -- custo rateado é 0 mesmo.
    round(coalesce(
      -- taxas percentuais incidem sobre produto + frete cobrado
      (
        (sr.gross_amount - sr.discount_amount)
        + case when sr.source = 'external' then 0::numeric else coalesce(os.revenue, 0::numeric) end
            * (sr.gross_amount - sr.discount_amount) / nullif(ot.order_net, 0::numeric)
      ) * (
        fr.taxa_shopify_pct
        + case when sr.payment_method = 'pix' then fr.taxa_gateway_pix_pct else fr.taxa_gateway_cartao_pct end
        + fr.imposto_pct
      )
      -- comissão de influencer: só com cupom, e só sobre o produto
      + (sr.gross_amount - sr.discount_amount)
          * fr.comissao_influencer_pct * case when sr.has_coupon then 1 else 0 end
      -- taxa fixa do pedido (pix fixo ou antifraude), rateada por item
      + case when sr.payment_method = 'pix' then fr.taxa_gateway_pix_fixo else fr.taxa_antifraude_fixo end
          * (sr.gross_amount - sr.discount_amount) / nullif(ot.order_net, 0::numeric)
    , 0::numeric), 2) as sale_cost,
    round(coalesce(oa.marketing_cost, 0::numeric), 2) as marketing_cost,
    round(coalesce(oa.fixed_cost, 0::numeric), 2) as fixed_cost,
    round(coalesce(
      case when sr.source = 'external' then 0::numeric else coalesce(os.revenue, 0::numeric) end
        * (sr.gross_amount - sr.discount_amount) / nullif(ot.order_net, 0::numeric)
    , 0::numeric), 2) as shipping_revenue,
    round(coalesce(
      case when sr.source = 'external' then 0::numeric
           else coalesce(os.cost, base.taxa_frete_estimado) end
        * (sr.gross_amount - sr.discount_amount) / nullif(ot.order_net, 0::numeric)
    , 0::numeric), 2) as shipping_cost,
    round(coalesce(
      case when sr.source = 'external' then 0::numeric else coalesce(os.cost_adjustment, 0::numeric) end
        * (sr.gross_amount - sr.discount_amount) / nullif(ot.order_net, 0::numeric)
    , 0::numeric), 2) as shipping_adjustment,
    (os.cost is not null) as has_real_shipping_cost,
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
  left join order_totals ot on ot.order_key = coalesce(sr.shopify_order_id::text, sr.external_order_id::text)
  left join order_shipping os on os.shopify_order_id = sr.shopify_order_id
  join sale_fee_rates fr on fr.id = case when sr.source = 'external' then 2 else 1 end
  join sale_fee_rates base on base.id = 1
)
select
  sale_id,
  product_sku,
  product_name,
  quantity,
  gross_amount,
  discount_amount,
  sale_date,
  direct_cost,
  sale_cost,
  marketing_cost,
  fixed_cost,
  shipping_revenue,
  shipping_cost,
  shipping_adjustment,
  has_real_shipping_cost,
  round(
    gross_amount - direct_cost - sale_cost - marketing_cost - fixed_cost
    + shipping_revenue - shipping_cost - shipping_adjustment
  , 2) as net_profit,
  product_line,
  piece_name,
  has_coupon,
  payment_method,
  source
from components;

alter view sale_margin set (security_invoker = true);

create view monthly_dre as
select
  (date_trunc('month', sale_date))::date as month,
  sum(gross_amount) as gross_revenue,
  sum(discount_amount) as discount_amount,
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

-- Drop de view apaga os grants junto — reaplica pra não depender de default
-- privilege (o acesso real continua barrado pela RLS das tabelas, porque as
-- views são security_invoker).
grant select on sale_margin, monthly_dre to authenticated;
grant select on sale_margin, monthly_dre to service_role;

notify pgrst, 'reload schema';

commit;
