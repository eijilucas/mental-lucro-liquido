-- ============================================================================
-- Reclassifica pra product_line='external' as peças de drop exclusivo que
-- não são o drop atual (mesmo critério da box "Venda Externa" no front:
-- exclusivo + tem coleção + coleção != a mais recente por
-- collection_published_at). Passam a aparecer em "Custo de cada peça —
-- Vendas Externas" em vez de sumir do painel de custo.
--
-- Efeito colateral: no Dashboard, a DRE "Exclusivos" filtra por
-- product_line='exclusivo' sem olhar coleção — essas vendas antigas saem
-- de lá (não existe waterfall "Externas" hoje pra elas reaparecerem).
-- ============================================================================

with current_collection as (
  select collection
  from product_costs
  where product_line = 'exclusivo' and collection is not null and collection_published_at is not null
  order by collection_published_at desc
  limit 1
)
update product_costs
set product_line = 'external', updated_at = now()
where product_line = 'exclusivo'
  and collection is not null
  and collection <> (select collection from current_collection);
