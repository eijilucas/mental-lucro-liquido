-- ============================================================================
-- Terceira linha de produto: 'external' — peças que só existem no catálogo do
-- Vendas Externas (nunca venderam pela Shopify), pra não empurrar pro Drop
-- Básico por padrão e poluir aquele painel. Produto que já vende pela
-- Shopify continua na linha dele (basico/exclusivo) — o stub do
-- register-external-sale só cria linha nova quando shopify_product_id ainda
-- não existe em product_costs (ignoreDuplicates).
-- ============================================================================

alter table product_costs drop constraint if exists product_costs_product_line_check;
alter table product_costs add constraint product_costs_product_line_check
  check (product_line in ('basico', 'exclusivo', 'external'));
