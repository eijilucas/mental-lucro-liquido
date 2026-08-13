-- ============================================================================
-- Guarda a data de publicação da coleção (vinda da Shopify) pra saber
-- qual é o "drop atual" sem precisar hardcodar o nome — é sempre a
-- coleção com o published_at mais recente. Assim, quando a Shopify tiver
-- um drop novo, ele aparece sozinho como atual na tela, sem precisar
-- mexer em código de novo.
-- ============================================================================

alter table product_costs add column if not exists collection_published_at timestamptz;
