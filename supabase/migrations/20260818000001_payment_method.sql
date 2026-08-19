-- ============================================================================
-- Separa a taxa de gateway por forma de pagamento: cartão continua um
-- percentual fixo sobre o valor da venda, Pix vira percentual + uma taxa
-- fixa em R$ por PEDIDO (não por item — por isso é rateada
-- proporcionalmente ao faturamento entre os itens do mesmo pedido,
-- somando exatamente a taxa fixa configurada por pedido Pix).
--
-- payment_method vem do `payment_gateway_names` do pedido na Shopify —
-- qualquer nome de gateway contendo "pix" (case-insensitive) é marcado
-- como pix, o resto cai em cartão (default). Confirmar depois do deploy
-- com uma venda Pix real que o valor bateu; se o app de Pix usado tiver
-- um nome de gateway que não contém "pix", ajustar o webhook/import.
-- ============================================================================

alter table sale_revenue add column if not exists payment_method text not null default 'cartao'
  check (payment_method in ('cartao', 'pix'));

alter table sale_fee_rates add column if not exists taxa_gateway_cartao_pct numeric(6,4) not null default 0.0500;
alter table sale_fee_rates add column if not exists taxa_gateway_pix_pct numeric(6,4) not null default 0.0100;
alter table sale_fee_rates add column if not exists taxa_gateway_pix_fixo numeric(10,2) not null default 1.00;

drop view if exists monthly_dre;
drop view if exists sale_margin;

alter table sale_fee_rates drop column if exists taxa_gateway_pct;

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
  round(
    sr.gross_amount * (
      fr.taxa_shopify_pct
      + case when sr.payment_method = 'pix' then fr.taxa_gateway_pix_pct else fr.taxa_gateway_cartao_pct end
      + fr.imposto_pct + fr.comissao_influencer_pct + fr.desconto_medio_pct
    )
    + case when sr.payment_method = 'pix'
        then fr.taxa_gateway_pix_fixo * sr.gross_amount / nullif(ot.order_gross, 0)
        else 0
      end
  , 2) as sale_cost,
  round(coalesce(oa.marketing_cost, 0), 2) as marketing_cost,
  round(coalesce(oa.fixed_cost, 0), 2) as fixed_cost,
  round(
    sr.gross_amount
    - (coalesce(pc.tecido, 0) + coalesce(pc.estampa, 0) + coalesce(pc.costura, 0)
        + coalesce(fr.sacolinha, 0) + coalesce(fr.adesivo, 0) + coalesce(pc.outros_acabamentos, 0)) * sr.quantity
    - (
        sr.gross_amount * (
          fr.taxa_shopify_pct
          + case when sr.payment_method = 'pix' then fr.taxa_gateway_pix_pct else fr.taxa_gateway_cartao_pct end
          + fr.imposto_pct + fr.comissao_influencer_pct + fr.desconto_medio_pct
        )
        + case when sr.payment_method = 'pix'
            then fr.taxa_gateway_pix_fixo * sr.gross_amount / nullif(ot.order_gross, 0)
            else 0
          end
      )
    - coalesce(oa.marketing_cost, 0)
    - coalesce(oa.fixed_cost, 0)
  , 2) as net_profit,
  coalesce(pc.product_line, 'basico') as product_line,
  coalesce(pc.product_name, sr.product_name) as piece_name,
  sr.has_coupon,
  sr.payment_method
from sale_revenue sr
left join product_costs pc on pc.shopify_product_id = sr.shopify_product_id
left join sale_overhead_allocation oa on oa.sale_id = sr.shopify_order_id and oa.shopify_line_item_id = sr.shopify_line_item_id
left join (
  select shopify_order_id, sum(gross_amount) as order_gross
  from sale_revenue
  group by shopify_order_id
) ot on ot.shopify_order_id = sr.shopify_order_id
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

-- CREATE OR REPLACE VIEW não garante que reloptions (como
-- security_invoker) sobrevivam — reforça explicitamente pra não reabrir
-- o vazamento de RLS corrigido antes (ver 20260813000003).
alter view sale_margin set (security_invoker = true);
alter view monthly_dre set (security_invoker = true);
