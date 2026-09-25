-- ============================================================================
-- Três respostas sobre a operação:
--
-- 1. SACOLINHA E ADESIVO VÃO UM POR PEDIDO, não um por peça. O custo direto
--    multiplicava os dois pela quantidade de cada item — pedido de 3 peças
--    pagava 3 sacolinhas. Agora entram uma vez por pedido, divididos entre as
--    peças dele pela quantidade.
--
-- 2. COMISSÃO DE INFLUENCER COM EXCEÇÕES. Hoje todo cupom é de influencer,
--    mas pode surgir cupom da loja que não paga comissão. A venda passa a
--    guardar o código de cada cupom usado (coupon_codes, gravado pelo
--    shopify-webhook e pelo shopify-import-orders), e cupom cadastrado em
--    cupons_sem_comissao não gera comissão. Venda sem código gravado (antiga,
--    ou venda externa, que só manda has_coupon) continua pagando comissão
--    sempre que teve cupom.
--
--    Pra cadastrar uma exceção (sem tela por enquanto, igual admin_emails):
--      insert into cupons_sem_comissao (code, motivo) values ('BEMVINDO10', 'cupom da loja');
--
-- 3. PINGENTE tem custo de produção — isso é só código (as functions param de
--    pular pingente ao criar a linha de custo); nada muda aqui.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- Códigos de cupom da venda e lista de cupons que não pagam comissão
-- ----------------------------------------------------------------------------
alter table sale_revenue add column if not exists coupon_codes text[];

comment on column sale_revenue.coupon_codes is
  'Códigos de cupom usados no pedido (order.discount_codes). Null em venda anterior a 20260925000003 e em venda externa.';

create table if not exists cupons_sem_comissao (
  code text primary key,
  motivo text,
  created_at timestamptz not null default now()
);

alter table cupons_sem_comissao enable row level security;

drop policy if exists cupons_sem_comissao_admin_all on cupons_sem_comissao;
create policy cupons_sem_comissao_admin_all on cupons_sem_comissao
  for all using (is_admin_user()) with check (is_admin_user());

-- sale_margin é security_invoker: quem lê a view precisa ler esta tabela.
-- Grant explícito porque tabela nova não fica exposta sozinha.
grant select, insert, update, delete on cupons_sem_comissao to authenticated;
grant select on cupons_sem_comissao to service_role;

-- ----------------------------------------------------------------------------
-- Views: muda o custo direto (sacolinha/adesivo por pedido) e a comissão
-- (exceções). O resto é igual à 20260925000002.
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
    ot.order_units,
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
    round(
      (
        coalesce(pc.tecido, 0::numeric) + coalesce(pc.estampa, 0::numeric) + coalesce(pc.costura, 0::numeric)
        + coalesce(pc.outros_acabamentos, 0::numeric)
      ) * l.quantity::numeric
      -- sacolinha e adesivo vão um por pedido, divididos entre as peças dele
      + coalesce(
          (coalesce(base.sacolinha, 0::numeric) + coalesce(base.adesivo, 0::numeric))
            * l.quantity::numeric / nullif(l.order_units, 0)::numeric
        , 0::numeric)
    , 2) as direct_cost,
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
      + l.net * fr.comissao_influencer_pct * case
          when not l.has_coupon then 0
          -- venda sem o código gravado (anterior a esta migração, ou venda
          -- externa): todo cupom paga comissão, como sempre foi
          when coalesce(cardinality(l.coupon_codes), 0) = 0 then 1
          -- paga se algum cupom usado não está na lista de exceções
          when exists (
            select 1 from unnest(l.coupon_codes) as c(code)
            where not exists (select 1 from cupons_sem_comissao x where upper(x.code) = upper(c.code))
          ) then 1
          else 0
        end
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
