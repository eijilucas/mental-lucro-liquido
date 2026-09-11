-- ============================================================================
-- Ajusta a 20260912000003: aquela migração jogou TODO o catálogo de drops
-- antigos pra 'external' (inclusive peça que nunca vendeu nenhuma unidade,
-- por isso aparecia com custo zerado em "Custo de cada peça — Vendas
-- Externas"). Aqui a gente restringe: só fica 'external' a peça de drop
-- antigo que teve venda de verdade (tem linha em sale_revenue casando por
-- shopify_product_id, mesmo join usado em sale_margin). O resto volta pra
-- 'exclusivo', do jeito que estava antes — some do painel de novo, como era
-- originalmente.
-- ============================================================================

with current_collection as (
  select collection
  from product_costs
  where product_line in ('exclusivo', 'external')
    and collection is not null
    and collection_published_at is not null
  order by collection_published_at desc
  limit 1
),
touched as (
  -- exatamente as linhas que a 000003 reclassificou: external, tem coleção,
  -- coleção != a atual
  select id, shopify_product_id
  from product_costs
  where product_line = 'external'
    and collection is not null
    and collection <> (select collection from current_collection)
),
sold as (
  select distinct t.id
  from touched t
  join sale_revenue sr on sr.shopify_product_id = t.shopify_product_id
)
update product_costs
set
  product_line = case when id in (select id from sold) then 'external' else 'exclusivo' end,
  updated_at = now()
where id in (select id from touched);
