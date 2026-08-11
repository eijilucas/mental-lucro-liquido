-- ============================================================================
-- Lucro Líquido por Venda — Projeto B (Mental Madness)
-- Schema completo para Supabase (Postgres)
-- Rode este arquivo inteiro no SQL Editor do Supabase, ou via:
--   npx supabase db push
--
-- Este projeto não escreve nunca no Projeto A (painel de comissionamento).
-- `sale_revenue` é a cópia read-only trazida por uma function agendada,
-- rodando 1x/hora, a partir de `sales` / `sale_items` do Projeto A. As
-- outras quatro tabelas são só deste projeto.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- TABELA: sale_revenue (sincronizada — só leitura para o resto do sistema)
-- Uma linha por item vendido. `sale_id` é o id da venda no Projeto A; como
-- uma venda pode ter mais de um item, a chave de sincronização real é
-- (sale_id, product_sku).
-- ----------------------------------------------------------------------------
create table if not exists sale_revenue (
  sale_id uuid not null,
  product_sku text not null,
  product_name text not null,
  quantity integer not null default 1 check (quantity > 0),
  gross_amount numeric(12,2) not null check (gross_amount >= 0),
  sale_date timestamptz not null,
  synced_at timestamptz not null default now(),
  primary key (sale_id, product_sku)
);

create index if not exists idx_sale_revenue_sale_date on sale_revenue (sale_date);
create index if not exists idx_sale_revenue_sku on sale_revenue (product_sku);

-- ----------------------------------------------------------------------------
-- TABELA: product_costs (camada 1 — custo direto por peça)
-- Seis colunas numéricas, uma por item de custo. A soma é o custo direto
-- daquele SKU, aplicado a toda venda dele.
-- ----------------------------------------------------------------------------
create table if not exists product_costs (
  sku text primary key,
  product_name text not null,
  tecido numeric(10,2) not null default 0,
  estampa numeric(10,2) not null default 0,
  costura numeric(10,2) not null default 0,
  sacolinha numeric(10,2) not null default 0,
  adesivo numeric(10,2) not null default 0,
  outros_acabamentos numeric(10,2) not null default 0,
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- TABELA: sale_fee_rates (camada 2 — custos da venda)
-- Linha única (id = 1) com os percentuais aplicados sobre o valor bruto de
-- cada venda: taxa da plataforma, gateway, imposto e comissão de
-- influenciador (mesma taxa do painel de comissionamento, contabilizada
-- aqui como custo, não como recompensa).
-- ----------------------------------------------------------------------------
create table if not exists sale_fee_rates (
  id smallint primary key default 1 check (id = 1),
  taxa_shopify_pct numeric(6,4) not null default 0.0290,
  taxa_gateway_pct numeric(6,4) not null default 0.0349,
  imposto_pct numeric(6,4) not null default 0.0600,
  comissao_influencer_pct numeric(6,4) not null default 0.0500,
  desconto_medio_pct numeric(6,4) not null default 0,
  updated_at timestamptz not null default now()
);

insert into sale_fee_rates (id) values (1) on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- TABELA: monthly_overhead (camadas 3 e 4 — marketing e fixos, por mês)
-- Mesma tabela para as duas camadas; `is_marketing` separa uma da outra.
-- `allocation_method` decide como aquele gasto vira custo "por venda":
--   'per_unit'    -> dividido igualmente pelas peças vendidas no mês
--   'per_revenue' -> proporcional ao faturamento de cada venda no mês
-- ----------------------------------------------------------------------------
create table if not exists monthly_overhead (
  id uuid primary key default gen_random_uuid(),
  month date not null, -- sempre o dia 1 do mês, ex: 2026-08-01
  category text not null,
  amount numeric(12,2) not null check (amount >= 0),
  is_marketing boolean not null,
  allocation_method text not null check (allocation_method in ('per_unit', 'per_revenue')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_monthly_overhead_month on monthly_overhead (month);

-- ----------------------------------------------------------------------------
-- VIEW: monthly_totals
-- Base de rateio: quantas peças e quanto faturamento cada mês teve.
-- ----------------------------------------------------------------------------
create or replace view monthly_totals as
select
  date_trunc('month', sale_date)::date as month,
  sum(quantity) as units,
  sum(gross_amount) as revenue
from sale_revenue
group by 1;

-- ----------------------------------------------------------------------------
-- VIEW: sale_overhead_allocation
-- Quanto de marketing e de fixo cada venda absorve, somando todas as
-- categorias de monthly_overhead daquele mês conforme o método de cada uma.
-- ----------------------------------------------------------------------------
create or replace view sale_overhead_allocation as
select
  sr.sale_id,
  sr.product_sku,
  coalesce(sum(
    case when mo.allocation_method = 'per_unit' then mo.amount * sr.quantity / nullif(mt.units, 0)
         else mo.amount * sr.gross_amount / nullif(mt.revenue, 0)
    end
  ) filter (where mo.is_marketing), 0) as marketing_cost,
  coalesce(sum(
    case when mo.allocation_method = 'per_unit' then mo.amount * sr.quantity / nullif(mt.units, 0)
         else mo.amount * sr.gross_amount / nullif(mt.revenue, 0)
    end
  ) filter (where not mo.is_marketing), 0) as fixed_cost
from sale_revenue sr
join monthly_totals mt on mt.month = date_trunc('month', sr.sale_date)::date
left join monthly_overhead mo on mo.month = mt.month
group by sr.sale_id, sr.product_sku;

-- ----------------------------------------------------------------------------
-- VIEW: sale_margin
-- O cálculo completo, por item de venda: faturamento menos as quatro
-- camadas de custo (na ordem descrita na proposta de arquitetura).
-- ----------------------------------------------------------------------------
create or replace view sale_margin as
select
  sr.sale_id,
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
  , 2) as net_profit
from sale_revenue sr
left join product_costs pc on pc.sku = sr.product_sku
left join sale_overhead_allocation oa on oa.sale_id = sr.sale_id and oa.product_sku = sr.product_sku
cross join sale_fee_rates fr
where fr.id = 1;

-- ----------------------------------------------------------------------------
-- VIEW: monthly_dre
-- O mesmo cálculo, somado por mês — alimenta a DRE mensal do dashboard.
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- Tudo aqui é dado sensível (custo de peça, margem, DRE). Sem policy de
-- select para authenticated = ninguém lê pelo client key; toda leitura do
-- dashboard/admin passa por um usuário marcado como admin.
-- ----------------------------------------------------------------------------
alter table sale_revenue enable row level security;
alter table product_costs enable row level security;
alter table sale_fee_rates enable row level security;
alter table monthly_overhead enable row level security;

create or replace function is_admin_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(auth.jwt() ->> 'role', '') = 'admin';
$$;

drop policy if exists sale_revenue_admin_only on sale_revenue;
create policy sale_revenue_admin_only on sale_revenue
  for select using (is_admin_user());

drop policy if exists product_costs_admin_all on product_costs;
create policy product_costs_admin_all on product_costs
  for all using (is_admin_user()) with check (is_admin_user());

drop policy if exists sale_fee_rates_admin_all on sale_fee_rates;
create policy sale_fee_rates_admin_all on sale_fee_rates
  for all using (is_admin_user()) with check (is_admin_user());

drop policy if exists monthly_overhead_admin_all on monthly_overhead;
create policy monthly_overhead_admin_all on monthly_overhead
  for all using (is_admin_user()) with check (is_admin_user());

-- sale_revenue nunca recebe insert/update/delete de um client autenticado
-- comum: a sincronização roda com a Service Role, fora do RLS.
