-- ============================================================================
-- Revisão da matemática da DRE — 5 correções:
--
-- 1. APAGAR GASTO HERDÁVEL NÃO VOLTA MAIS. carry_forward_fixed_overhead copia
--    pro mês `m` tudo que existe no último mês anterior com gasto herdável.
--    Apagar "Contador" de agosto em diante deixava julho intacto — então na
--    próxima abertura do admin (ou no cron das 5h) agosto e setembro ganhavam
--    o Contador de volta. Agora apagar deixa um marcador (`encerrado = true`,
--    valor zero) no mês de onde parou: a herança enxerga o marcador, não
--    recria a linha naquele mês e não copia nada dele pros seguintes.
--    Cadastrar a mesma categoria de novo num mês depois volta a herdar dali.
--
-- 2. PEDIDO DE VALOR ZERO (brinde, cupom de 100%). Frete e taxa fixa do pedido
--    são rateados pelo peso do item no faturamento do pedido; com faturamento
--    zero a divisão virava NULL e o coalesce zerava o custo — a etiqueta paga
--    sumia da DRE. Agora, sem faturamento, o rateio é por quantidade de peças.
--    A taxa fixa (pix fixo / antifraude) só entra se houve pagamento de fato
--    (produto + frete cobrado > 0) — pedido totalmente gratuito não passa por
--    gateway.
--
-- 3. REEMBOLSO IDEMPOTENTE. O refunds/create subtraía do que estava gravado; a
--    Shopify pode reenviar o mesmo webhook, e aí o reembolso era descontado de
--    novo (podendo apagar a linha inteira). Agora o reembolso é aplicado por
--    uma função que registra o id do reembolso na mesma transação — reenvio
--    do mesmo id não faz nada.
--
-- 4. MÊS NO FUSO DE BRASÍLIA. A tela filtra por dia de Brasília, mas o rateio
--    agrupava o mês em UTC (padrão do banco): venda das 21h à meia-noite do
--    último dia do mês pegava o rateio de fixo/marketing do mês SEGUINTE, e a
--    soma dos fixos de um mês na tela não fechava com o valor cadastrado. O
--    "mês corrente" e os dias decorridos do rateio pró-rata também passam a
--    ser de Brasília.
--
-- 5. VALE-PRESENTE. A compra de gift card entrava como faturamento, e o
--    pedido pago com ele entrava de novo — a mesma receita contada duas
--    vezes. O shopify-webhook e o shopify-import-orders deixam de gravar o item
--    gift card; aqui saem as linhas que já tinham entrado (casadas pelo nome,
--    mesmo padrão /gift\s*card/i que o código já usava pra não criar custo).
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Marcador de gasto encerrado + herança que respeita o marcador
-- ----------------------------------------------------------------------------
alter table monthly_overhead add column if not exists encerrado boolean not null default false;

comment on column monthly_overhead.encerrado is
  'Marcador de "parou aqui": gasto herdável apagado a partir deste mês. Valor sempre zero, não aparece na tela nem entra no rateio; existe só pra carry_forward_fixed_overhead não recriar a categoria.';

create or replace function carry_forward_fixed_overhead()
returns void
language plpgsql
as $$
declare
  m date;
  cur_month date := date_trunc('month', now() at time zone 'America/Sao_Paulo')::date;
  first_month date;
  ref_month date;
begin
  select min(month) into first_month
  from monthly_overhead
  where not is_marketing or recorrente;
  if first_month is null then
    return;
  end if;

  m := first_month;
  while m <= cur_month loop
    -- último mês anterior a `m` com algum gasto herdável cadastrado — o
    -- marcador de encerrado conta, senão um mês que só tem marcador faria a
    -- busca pular pra trás e achar a categoria viva de novo
    select max(month) into ref_month
    from monthly_overhead
    where (not is_marketing or recorrente) and month < m;

    if ref_month is not null then
      insert into monthly_overhead (month, category, amount, is_marketing, allocation_method, manually_edited, recorrente)
      select m, ref.category, ref.amount, ref.is_marketing, ref.allocation_method, false, ref.recorrente
      from monthly_overhead ref
      where ref.month = ref_month
        and (not ref.is_marketing or ref.recorrente)
        and not ref.encerrado
        and not exists (
          -- compara dentro do mesmo balde: "Tráfego pago" de marketing não
          -- colide com um fixo de mesmo nome. O marcador de encerrado também
          -- bloqueia: é ele que impede a categoria apagada de voltar.
          select 1 from monthly_overhead x
          where x.month = m
            and x.category = ref.category
            and x.is_marketing = ref.is_marketing
        );
    end if;

    m := (m + interval '1 month')::date;
  end loop;
end;
$$;

grant execute on function carry_forward_fixed_overhead() to authenticated;

-- Apaga um gasto herdável desse mês pra frente e deixa o marcador no mês de
-- onde parou. Numa transação só, pra nunca ficar "apagado sem marcador" — que
-- é justamente o estado que a herança desfaz.
create or replace function encerrar_overhead_herdavel(p_category text, p_from_month date, p_is_marketing boolean)
returns void
language plpgsql
as $$
begin
  delete from monthly_overhead
  where category = p_category
    and is_marketing = p_is_marketing
    and month >= p_from_month;

  -- recorrente = true no marcador de marketing pra ele contar como herdável
  -- na busca do mês de referência (gasto fixo é herdável sempre).
  insert into monthly_overhead (month, category, amount, is_marketing, allocation_method, manually_edited, recorrente, encerrado)
  values (p_from_month, p_category, 0, p_is_marketing, 'per_unit', true, p_is_marketing, true);
end;
$$;

grant execute on function encerrar_overhead_herdavel(text, date, boolean) to authenticated;

-- ----------------------------------------------------------------------------
-- 3. Reembolso aplicado uma vez só por id
-- ----------------------------------------------------------------------------
create table if not exists shopify_refunds_aplicados (
  refund_id bigint primary key,
  shopify_order_id bigint not null,
  aplicado_em timestamptz not null default now()
);

-- Só o shopify-webhook (service role) mexe aqui. O grant é explícito porque
-- tabela nova não fica mais exposta sozinha aos papéis da API (ver
-- auto_expose_new_tables no config.toml) — sem ele o reembolso falha com
-- permission denied.
alter table shopify_refunds_aplicados enable row level security;
grant select, insert on shopify_refunds_aplicados to service_role;

-- p_itens: [{ "line_item_id": 123, "quantity": 1, "unit_price": 99.90 }, ...]
-- Devolve false quando esse reembolso já tinha sido aplicado (reenvio).
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
  insert into shopify_refunds_aplicados (refund_id, shopify_order_id)
  values (p_refund_id, p_order_id)
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
-- 5. Tira da receita a compra de vale-presente que já tinha entrado
-- ----------------------------------------------------------------------------
delete from sale_revenue sr
where sr.source = 'shopify'
  and sr.product_name ~* 'gift\s*card'
  -- gift card nunca ganha linha de custo (ensureProductCostStubs pula);
  -- se alguém cadastrou custo pra esse produto, não é gift card de verdade
  and not exists (select 1 from product_costs pc where pc.shopify_product_id = sr.shopify_product_id);

-- ----------------------------------------------------------------------------
-- 2 e 4. Views
-- ----------------------------------------------------------------------------
drop view if exists monthly_dre;
drop view if exists sale_margin;
drop view if exists sale_overhead_allocation;
drop view if exists monthly_totals;

-- Base de rateio: unidades e faturamento LÍQUIDO por mês de Brasília.
create view monthly_totals as
select
  date_trunc('month', sale_date at time zone 'America/Sao_Paulo')::date as month,
  sum(quantity) as units,
  sum(gross_amount - discount_amount) as revenue
from sale_revenue
group by 1;

alter view monthly_totals set (security_invoker = true);

-- Quanto de marketing e de fixo cada venda absorve. No mês corrente, fixo e
-- marketing recorrente herdado entram proporcionais aos dias decorridos;
-- marketing digitado na mão é gasto já realizado e entra inteiro.
create view sale_overhead_allocation as
with hoje as (
  select
    date_trunc('month', now() at time zone 'America/Sao_Paulo')::date as mes_corrente,
    least(
      1::numeric,
      extract(day from now() at time zone 'America/Sao_Paulo')::numeric
        / extract(day from (date_trunc('month', now() at time zone 'America/Sao_Paulo') + interval '1 month' - interval '1 day'))::numeric
    ) as fracao_mes_corrente
),
rateio as (
  select
    coalesce(sr.shopify_order_id::text, sr.external_order_id::text) as sale_key,
    coalesce(sr.shopify_line_item_id::text, sr.external_item_id::text) as line_key,
    mo.is_marketing,
    (case
      when mo.allocation_method = 'per_unit' then (mo.amount * sr.quantity::numeric) / nullif(mt.units, 0)::numeric
      else (mo.amount * (sr.gross_amount - sr.discount_amount)) / nullif(mt.revenue, 0::numeric)
    end)
    * case
        when mt.month <> h.mes_corrente then 1::numeric
        when mo.is_marketing and (not mo.recorrente or mo.manually_edited) then 1::numeric
        else h.fracao_mes_corrente
      end as valor
  from sale_revenue sr
  join monthly_totals mt on mt.month = date_trunc('month', sr.sale_date at time zone 'America/Sao_Paulo')::date
  cross join hoje h
  left join monthly_overhead mo on mo.month = mt.month and not mo.encerrado
)
select
  sale_key,
  line_key,
  coalesce(sum(valor) filter (where is_marketing), 0::numeric) as marketing_cost,
  coalesce(sum(valor) filter (where not is_marketing), 0::numeric) as fixed_cost
from rateio
group by 1, 2;

alter view sale_overhead_allocation set (security_invoker = true);

-- Margem por linha de venda. gross_amount aqui é LÍQUIDO de desconto.
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
    -- pedido saiu de graça (brinde, cupom de 100%) — senão a etiqueta paga
    -- desses pedidos sumia da DRE.
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
        fr.taxa_shopify_pct
        + case when l.payment_method = 'pix' then fr.taxa_gateway_pix_pct else fr.taxa_gateway_cartao_pct end
        + fr.imposto_pct
      )
      -- comissão de influencer: só com cupom, e só sobre o produto
      + l.net * fr.comissao_influencer_pct * case when l.has_coupon then 1 else 0 end
      -- taxa fixa do pedido (pix fixo ou antifraude), rateada por item — só
      -- quando o cliente pagou alguma coisa
      + case
          when l.order_net + coalesce(os.revenue, 0::numeric) > 0
            then case when l.payment_method = 'pix' then fr.taxa_gateway_pix_fixo else fr.taxa_antifraude_fixo end
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
grant select on monthly_totals, sale_overhead_allocation, sale_margin, monthly_dre to authenticated;
grant select on monthly_totals, sale_overhead_allocation, sale_margin, monthly_dre to service_role;

notify pgrst, 'reload schema';

commit;
