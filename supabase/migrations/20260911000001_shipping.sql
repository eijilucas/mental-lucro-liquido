-- ============================================================================
-- Frete: resultado por pedido = frete cobrado no checkout − frete real pago.
--
--  * revenue  vem da Shopify (total_shipping_price_set) — capturado pelo
--    shopify-webhook / shopify-import-orders. É o valor fixo por estado que o
--    site cobra (SP 30, AC 90, ...), então em pedido de estado barato sobra
--    frete e em estado caro falta.
--  * cost     vem do mm-etiquetas (edge function shipping-cost-callback), que
--    é onde a etiqueta é comprada de fato na Melhor Envio. Pedido sem etiqueta
--    comprada pelo sistema (rastreio manual, comprada por fora) fica com cost
--    nulo e cai no custo estimado editável (sale_fee_rates.taxa_frete_estimado).
--
-- Os dois entram rateados proporcionalmente ao faturamento entre os itens do
-- mesmo pedido — mesma mecânica da taxa fixa do Pix / antifraude.
--
-- Pré-requisito: 20260910000003_external_sales (coluna sale_revenue.source,
-- fee row id=2, views com chave shopify_* OU external_*).
-- ============================================================================

begin;

alter table sale_fee_rates
  add column if not exists taxa_frete_estimado numeric(10,2) not null default 0;

create table if not exists order_shipping (
  shopify_order_id  bigint primary key,
  order_number      text,
  revenue           numeric(12,2),          -- frete cobrado do cliente (Shopify)
  cost              numeric(12,2),           -- frete real pago (mm-etiquetas); null = usa estimativa
  revenue_synced_at timestamptz,
  cost_synced_at    timestamptz
);

alter table order_shipping enable row level security;
drop policy if exists order_shipping_admin_only on order_shipping;
create policy order_shipping_admin_only on order_shipping
  for select using (is_admin_user());

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
      + fr.comissao_influencer_pct * case when sr.source = 'external' and not sr.has_coupon then 0 else 1 end
      + fr.desconto_medio_pct
    )
    + (case when sr.payment_method = 'pix' then fr.taxa_gateway_pix_fixo else fr.taxa_antifraude_fixo end
       * sr.gross_amount) / nullif(ot.order_gross, 0::numeric)
  , 2) as sale_cost,
  round(coalesce(oa.marketing_cost, 0::numeric), 2) as marketing_cost,
  round(coalesce(oa.fixed_cost, 0::numeric), 2) as fixed_cost,
  -- frete rateado pelo peso do item dentro do pedido
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
          + fr.comissao_influencer_pct * case when sr.source = 'external' and not sr.has_coupon then 0 else 1 end
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
  sum(net_profit) as net_profit
from sale_margin
group by 1;

alter view monthly_dre set (security_invoker = true);

commit;
