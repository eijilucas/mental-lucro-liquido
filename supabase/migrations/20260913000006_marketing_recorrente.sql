-- ============================================================================
-- Gasto de marketing que se repete todo mês (tráfego pago).
--
-- Até aqui só gasto fixo era herdado — marketing era sempre mês a mês, na
-- premissa de que campanha muda todo mês. Tráfego pago não é campanha: é uma
-- torneira aberta com valor parecido todo mês, e recadastrar na mão é convite
-- pra esquecer e inflar o lucro.
--
-- Agora cada linha de marketing tem `recorrente`. Ligada, ela é herdada pelo
-- mês seguinte igual a um gasto fixo (e editar o valor propaga pra frente, e
-- apagar apaga desse mês em diante). Desligada — o padrão — continua exatamente
-- como era. Gasto fixo não muda: continua sempre herdando.
--
-- Rateio no mês corrente: gasto herdado é projeção do mês inteiro, então entra
-- proporcional aos dias decorridos, mesma regra que já vale pro fixo. Marketing
-- que você digitou na mão (`manually_edited`) é dinheiro já gasto e entra
-- inteiro — por isso o fator olha as duas flags.
-- ============================================================================

begin;

alter table monthly_overhead add column if not exists recorrente boolean not null default false;

comment on column monthly_overhead.recorrente is
  'Só para marketing: quando true, a linha é herdada pelos meses seguintes como um gasto fixo. Gasto fixo (is_marketing = false) é sempre herdado, independente desta coluna.';

-- ----------------------------------------------------------------------------
-- Herança: agora carrega gasto fixo OU marketing marcado como recorrente.
-- ----------------------------------------------------------------------------
create or replace function carry_forward_fixed_overhead()
returns void
language plpgsql
as $$
declare
  m date;
  cur_month date := date_trunc('month', now())::date;
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
    -- último mês anterior a `m` com algum gasto herdável cadastrado
    select max(month) into ref_month
    from monthly_overhead
    where (not is_marketing or recorrente) and month < m;

    if ref_month is not null then
      insert into monthly_overhead (month, category, amount, is_marketing, allocation_method, manually_edited, recorrente)
      select m, ref.category, ref.amount, ref.is_marketing, ref.allocation_method, false, ref.recorrente
      from monthly_overhead ref
      where ref.month = ref_month
        and (not ref.is_marketing or ref.recorrente)
        and not exists (
          -- compara dentro do mesmo balde: "Tráfego pago" de marketing não
          -- colide com um fixo de mesmo nome
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

-- ----------------------------------------------------------------------------
-- Rateio. `create or replace` (e não drop/create) porque as colunas não mudam
-- — assim sale_margin, que depende desta view, continua de pé.
-- ----------------------------------------------------------------------------
create or replace view sale_overhead_allocation as
select
  coalesce(sr.shopify_order_id::text, sr.external_order_id::text) as sale_key,
  coalesce(sr.shopify_line_item_id::text, sr.external_item_id::text) as line_key,
  coalesce(sum(
    (case
      when mo.allocation_method = 'per_unit' then (mo.amount * sr.quantity::numeric) / nullif(mt.units, 0)::numeric
      else (mo.amount * (sr.gross_amount - sr.discount_amount)) / nullif(mt.revenue, 0::numeric)
    end)
    * case
        when mt.month <> date_trunc('month', now())::date then 1::numeric
        -- marketing digitado na mão = gasto já realizado, entra inteiro
        when not mo.recorrente or mo.manually_edited then 1::numeric
        else least(
          1::numeric,
          extract(day from now())::numeric
            / extract(day from (date_trunc('month', now()) + interval '1 month' - interval '1 day'))::numeric
        )
      end
  ) filter (where mo.is_marketing), 0::numeric) as marketing_cost,
  coalesce(sum(
    (case
      when mo.allocation_method = 'per_unit' then (mo.amount * sr.quantity::numeric) / nullif(mt.units, 0)::numeric
      else (mo.amount * (sr.gross_amount - sr.discount_amount)) / nullif(mt.revenue, 0::numeric)
    end)
    * case
        when mt.month <> date_trunc('month', now())::date then 1::numeric
        else least(
          1::numeric,
          extract(day from now())::numeric
            / extract(day from (date_trunc('month', now()) + interval '1 month' - interval '1 day'))::numeric
        )
      end
  ) filter (where not mo.is_marketing), 0::numeric) as fixed_cost
from sale_revenue sr
join monthly_totals mt on mt.month = (date_trunc('month', sr.sale_date))::date
left join monthly_overhead mo on mo.month = mt.month
group by 1, 2;

alter view sale_overhead_allocation set (security_invoker = true);

select carry_forward_fixed_overhead();

commit;
