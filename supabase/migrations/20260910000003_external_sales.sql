-- ============================================================================
-- Vendas do "Vendas Externas" (pedidos WhatsApp/Discord/Instagram que nunca
-- passam pelo checkout da Shopify) entram na mesma sale_revenue, marcadas
-- com source='external'. Sem isso a DRE só enxergava venda da Shopify.
--
-- Contrato: mental-madness-vendas-externas/docs/api-contracts/07-jackpot-lucro-liquido.md
--
-- Pedido do grupo "Pedidos dos Membros" (peça enviada pro time) NÃO é
-- mandado pra cá — a regra fica no Vendas Externas, aqui não tem nada
-- especial pra esse caso.
--
-- Linha da venda externa casa com product_costs pelo mesmo shopify_product_id
-- (o item do Vendas Externas já vem casado com produto do catálogo id
-- "shopify-<n>"). Taxa é a linha id=2 de sale_fee_rates (sem taxa Shopify,
-- sem cartão; pix + imposto + comissão de influencer só quando teve cupom).
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- sale_revenue: duas origens
-- ----------------------------------------------------------------------------
alter table sale_revenue
  add column if not exists source text not null default 'shopify'
    check (source in ('shopify', 'external')),
  add column if not exists external_order_id uuid,
  add column if not exists external_item_id uuid;

alter table sale_revenue alter column shopify_order_id drop not null;
alter table sale_revenue alter column shopify_line_item_id drop not null;

-- PK composta (shopify_order_id, shopify_line_item_id) vira surrogate id.
-- Os dois pares naturais viram unique constraint plana (não parcial): NULL
-- não conflita com NULL no Postgres, então linha shopify (external_* NULL) e
-- linha externa (shopify_* NULL) convivem sem colidir — e o upsert do
-- PostgREST/supabase-js consegue usar como ON CONFLICT (não aceita índice
-- parcial). Mesmo truque de product_costs_variant_id_key.
alter table sale_revenue drop constraint if exists sale_revenue_pkey;
alter table sale_revenue add column if not exists id uuid not null default gen_random_uuid();
alter table sale_revenue add constraint sale_revenue_pkey primary key (id);
alter table sale_revenue drop constraint if exists sale_revenue_shopify_key;
alter table sale_revenue add constraint sale_revenue_shopify_key
  unique (shopify_order_id, shopify_line_item_id);
alter table sale_revenue drop constraint if exists sale_revenue_external_key;
alter table sale_revenue add constraint sale_revenue_external_key
  unique (external_order_id, external_item_id);

create index if not exists idx_sale_revenue_external_order on sale_revenue (external_order_id);

-- ----------------------------------------------------------------------------
-- sale_fee_rates: linha 2 = perfil de taxa da venda externa
-- ----------------------------------------------------------------------------
alter table sale_fee_rates drop constraint if exists sale_fee_rates_id_check;
alter table sale_fee_rates add constraint sale_fee_rates_id_check check (id in (1, 2));

-- taxa_shopify_pct 0, gateway de cartão 0, antifraude 0 (não é cartão);
-- pix 1% + R$1 fixo; imposto 6%; comissão de influencer 5% (a view só
-- aplica quando has_coupon). sacolinha/adesivo NÃO ficam aqui — a view lê
-- sempre da linha 1 (custo físico de embalagem é o mesmo).
insert into sale_fee_rates (
  id, taxa_shopify_pct, imposto_pct, comissao_influencer_pct, desconto_medio_pct,
  sacolinha, adesivo, taxa_gateway_cartao_pct, taxa_gateway_pix_pct,
  taxa_gateway_pix_fixo, taxa_antifraude_fixo
) values (
  2, 0, 0.0600, 0.0500, 0,
  0, 0, 0, 0.0100,
  1.00, 0
) on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- Views: chave de venda/item unificada (shopify_* OU external_*), fee row
-- por origem, comissão de influencer condicional pra venda externa.
-- ----------------------------------------------------------------------------
drop view if exists monthly_dre;
drop view if exists sale_margin;
drop view if exists sale_overhead_allocation;

create view sale_overhead_allocation as
select
  coalesce(sr.shopify_order_id::text, sr.external_order_id::text) as sale_key,
  coalesce(sr.shopify_line_item_id::text, sr.external_item_id::text) as line_key,
  coalesce(sum(
    case
      when mo.allocation_method = 'per_unit' then (mo.amount * sr.quantity::numeric) / nullif(mt.units, 0)::numeric
      else (mo.amount * sr.gross_amount) / nullif(mt.revenue, 0::numeric)
    end
  ) filter (where mo.is_marketing), 0::numeric) as marketing_cost,
  coalesce(sum(
    case
      when mo.allocation_method = 'per_unit' then (mo.amount * sr.quantity::numeric) / nullif(mt.units, 0)::numeric
      else (mo.amount * sr.gross_amount) / nullif(mt.revenue, 0::numeric)
    end
  ) filter (where not mo.is_marketing), 0::numeric) as fixed_cost
from sale_revenue sr
join monthly_totals mt on mt.month = (date_trunc('month', sr.sale_date))::date
left join monthly_overhead mo on mo.month = mt.month
group by 1, 2;

alter view sale_overhead_allocation set (security_invoker = true);

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
  sum(net_profit) as net_profit
from sale_margin
group by 1;

alter view monthly_dre set (security_invoker = true);

commit;
