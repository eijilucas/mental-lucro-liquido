-- ============================================================================
-- Frete das Vendas Externas entra na DRE.
--
-- Até aqui a sale_margin zerava receita E custo de frete pra source='external',
-- na premissa de que venda externa não tem frete. A premissa está errada do
-- lado do custo: você compra etiqueta pra esses pedidos igual — no dump de
-- julho/agosto da Melhor Envio, das 885 etiquetas só 379 eram de pedido da
-- Shopify; o grosso do resto é venda externa. São uns R$ 6.600 em dois meses
-- que a DRE não via, e que viravam lucro.
--
-- order_shipping passa a aceitar as duas chaves, igual sale_revenue já faz:
-- shopify_order_id para pedido da loja, external_order_id para venda externa.
-- Índice único em cada uma — no Postgres NULL não colide com NULL, então as
-- linhas de um tipo não atrapalham as do outro.
--
-- Frete cobrado do cliente em venda externa só existe a partir de hoje (o
-- campo acabou de ser criado lá); o custo é recuperável pra trás pelo
-- histórico da Melhor Envio.
-- ============================================================================

begin;

-- uuid, igual a sale_revenue.external_order_id — assim o join é uuid = uuid e
-- id malformado falha na hora de gravar, em vez de simplesmente nunca casar.
alter table order_shipping add column if not exists external_order_id uuid;

-- shopify_order_id era a PK; vira apenas única, e passa a aceitar nulo pras
-- linhas de venda externa.
alter table order_shipping drop constraint if exists order_shipping_pkey;
alter table order_shipping alter column shopify_order_id drop not null;

create unique index if not exists order_shipping_shopify_order_id_key
  on order_shipping (shopify_order_id);
create unique index if not exists order_shipping_external_order_id_key
  on order_shipping (external_order_id);

-- Uma linha tem que ter exatamente uma das duas chaves.
alter table order_shipping drop constraint if exists order_shipping_uma_chave;
alter table order_shipping add constraint order_shipping_uma_chave
  check (num_nonnulls(shopify_order_id, external_order_id) = 1);

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
        + coalesce(os.revenue, 0::numeric)
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
      coalesce(os.revenue, 0::numeric)
        * (sr.gross_amount - sr.discount_amount) / nullif(ot.order_net, 0::numeric)
    , 0::numeric), 2) as shipping_revenue,
    round(coalesce(
      coalesce(os.cost, base.taxa_frete_estimado)
        * (sr.gross_amount - sr.discount_amount) / nullif(ot.order_net, 0::numeric)
    , 0::numeric), 2) as shipping_cost,
    round(coalesce(
      coalesce(os.cost_adjustment, 0::numeric)
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
  left join order_shipping os
    on coalesce(os.shopify_order_id::text, os.external_order_id::text)
     = coalesce(sr.shopify_order_id::text, sr.external_order_id::text)
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
