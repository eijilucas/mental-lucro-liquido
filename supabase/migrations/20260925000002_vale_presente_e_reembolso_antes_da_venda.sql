-- ============================================================================
-- Duas sobras da revisão da DRE (20260925000001):
--
-- 1. PEDIDO PAGO COM VALE-PRESENTE. payment_method só conhecia pix e cartão,
--    e tudo que não tinha "pix" no gateway caía como cartão — pedido pago
--    inteiro com vale-presente pagava gateway de cartão, antifraude e taxa da
--    Shopify sem ter passado por gateway nenhum. Agora esse pedido entra como
--    'vale_presente': sem taxa de gateway, sem antifraude e sem taxa de
--    transação da Shopify. Imposto continua (a receita é reconhecida aqui).
--    Pedido pago em parte com vale e em parte no cartão/Pix continua como
--    cartão/Pix — o payload do pedido não diz quanto foi pago em cada meio.
--
-- 2. REEMBOLSO GUARDA OS ITENS. O orders/paid regrava as linhas com a
--    quantidade original do pedido; se ele chegasse de novo (reenvio da
--    Shopify) depois de um reembolso, desfazia o reembolso — e se chegasse
--    depois de um reembolso que já tinha passado, gravava a venda cheia.
--    Guardando os itens de cada reembolso aplicado, o shopify-webhook desconta
--    do pedido o que já foi devolvido, em qualquer ordem de chegada.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Vale-presente como forma de pagamento
-- ----------------------------------------------------------------------------
alter table sale_revenue drop constraint if exists sale_revenue_payment_method_check;
alter table sale_revenue add constraint sale_revenue_payment_method_check
  check (payment_method in ('cartao', 'pix', 'vale_presente'));

-- ----------------------------------------------------------------------------
-- 2. Itens do reembolso
-- ----------------------------------------------------------------------------
alter table shopify_refunds_aplicados add column if not exists itens jsonb not null default '[]'::jsonb;

create or replace function aplicar_reembolso_shopify(p_refund_id bigint, p_order_id bigint, p_itens jsonb)
returns boolean
language plpgsql
as $$
declare
  item jsonb;
  linha record;
  qtd_devolvida integer;
  nova_qtd integer;
begin
  -- os itens ficam gravados pro orders/paid conseguir descontar o reembolso
  -- se chegar depois dele
  insert into shopify_refunds_aplicados (refund_id, shopify_order_id, itens)
  values (p_refund_id, p_order_id, coalesce(p_itens, '[]'::jsonb))
  on conflict (refund_id) do nothing;
  if not found then
    return false;
  end if;

  for item in select * from jsonb_array_elements(coalesce(p_itens, '[]'::jsonb)) loop
    select quantity, gross_amount, discount_amount into linha
    from sale_revenue
    where shopify_order_id = p_order_id
      and shopify_line_item_id = (item ->> 'line_item_id')::bigint
    for update;
    if not found then
      continue;
    end if;

    qtd_devolvida := (item ->> 'quantity')::integer;
    nova_qtd := greatest(0, linha.quantity - qtd_devolvida);

    if nova_qtd = 0 then
      delete from sale_revenue
      where shopify_order_id = p_order_id
        and shopify_line_item_id = (item ->> 'line_item_id')::bigint;
    else
      update sale_revenue
      set quantity = nova_qtd,
          gross_amount = greatest(0, linha.gross_amount - coalesce((item ->> 'unit_price')::numeric, 0) * qtd_devolvida),
          -- o desconto acompanha as unidades que sobraram
          discount_amount = round(linha.discount_amount * nova_qtd / linha.quantity, 2)
      where shopify_order_id = p_order_id
        and shopify_line_item_id = (item ->> 'line_item_id')::bigint;
    end if;
  end loop;

  return true;
end;
$$;

revoke execute on function aplicar_reembolso_shopify(bigint, bigint, jsonb) from public, anon, authenticated;
grant execute on function aplicar_reembolso_shopify(bigint, bigint, jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- Views: só as taxas mudam (vale-presente não paga gateway, antifraude nem
-- taxa da Shopify). O resto é igual à 20260925000001.
-- ----------------------------------------------------------------------------
drop view if exists monthly_dre;
drop view if exists sale_margin;

create view sale_margin as
with order_totals as (
  select
    coalesce(shopify_order_id::text, external_order_id::text) as order_key,
    sum(gross_amount - discount_amount) as order_net,
    sum(quantity) as order_units
  from sale_revenue
  group by 1
),
lines as (
  select
    sr.*,
    coalesce(sr.shopify_order_id::text, sr.external_order_id::text) as order_key,
    coalesce(sr.shopify_line_item_id::text, sr.external_item_id::text) as line_key,
    (sr.gross_amount - sr.discount_amount) as net,
    ot.order_net,
    -- Peso do item no pedido, pra ratear o que é do pedido inteiro (frete,
    -- taxa fixa): pelo faturamento, ou pela quantidade de peças quando o
    -- pedido saiu de graça (brinde, cupom de 100%).
    case
      when ot.order_net > 0 then (sr.gross_amount - sr.discount_amount) / ot.order_net
      else sr.quantity::numeric / nullif(ot.order_units, 0)::numeric
    end as share
  from sale_revenue sr
  left join order_totals ot on ot.order_key = coalesce(sr.shopify_order_id::text, sr.external_order_id::text)
),
components as (
  select
    l.order_key as sale_id,
    l.product_sku,
    l.product_name,
    l.quantity,
    l.net as gross_amount,
    l.discount_amount,
    l.sale_date,
    (
      coalesce(pc.tecido, 0::numeric) + coalesce(pc.estampa, 0::numeric) + coalesce(pc.costura, 0::numeric)
      + coalesce(base.sacolinha, 0::numeric) + coalesce(base.adesivo, 0::numeric)
      + coalesce(pc.outros_acabamentos, 0::numeric)
    ) * l.quantity::numeric as direct_cost,
    round(coalesce(
      -- taxas percentuais incidem sobre produto + frete cobrado
      (l.net + coalesce(os.revenue, 0::numeric) * l.share) * (
        case when l.payment_method = 'vale_presente' then 0::numeric else fr.taxa_shopify_pct end
        + case l.payment_method
            when 'pix' then fr.taxa_gateway_pix_pct
            when 'vale_presente' then 0::numeric
            else fr.taxa_gateway_cartao_pct
          end
        + fr.imposto_pct
      )
      -- comissão de influencer: só com cupom, e só sobre o produto
      + l.net * fr.comissao_influencer_pct * case when l.has_coupon then 1 else 0 end
      -- taxa fixa do pedido (pix fixo ou antifraude), rateada por item — só
      -- quando o cliente pagou alguma coisa
      + case
          when l.order_net + coalesce(os.revenue, 0::numeric) > 0
            then case l.payment_method
                   when 'pix' then fr.taxa_gateway_pix_fixo
                   when 'vale_presente' then 0::numeric
                   else fr.taxa_antifraude_fixo
                 end
                 * l.share
          else 0::numeric
        end
    , 0::numeric), 2) as sale_cost,
    round(coalesce(oa.marketing_cost, 0::numeric), 2) as marketing_cost,
    round(coalesce(oa.fixed_cost, 0::numeric), 2) as fixed_cost,
    round(coalesce(coalesce(os.revenue, 0::numeric) * l.share, 0::numeric), 2) as shipping_revenue,
    round(coalesce(coalesce(os.cost, base.taxa_frete_estimado) * l.share, 0::numeric), 2) as shipping_cost,
    round(coalesce(coalesce(os.cost_adjustment, 0::numeric) * l.share, 0::numeric), 2) as shipping_adjustment,
    (os.cost is not null) as has_real_shipping_cost,
    coalesce(pc.product_line, 'basico') as product_line,
    coalesce(pc.product_name, l.product_name) as piece_name,
    l.has_coupon,
    l.payment_method,
    l.source
  from lines l
  left join product_costs pc on pc.shopify_product_id = l.shopify_product_id
  left join sale_overhead_allocation oa on oa.sale_key = l.order_key and oa.line_key = l.line_key
  left join order_shipping os
    on coalesce(os.shopify_order_id::text, os.external_order_id::text) = l.order_key
  join sale_fee_rates fr on fr.id = case when l.source = 'external' then 2 else 1 end
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
  date_trunc('month', sale_date at time zone 'America/Sao_Paulo')::date as month,
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
