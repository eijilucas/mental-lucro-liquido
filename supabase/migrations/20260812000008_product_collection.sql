-- ============================================================================
-- Adiciona a coleção da Shopify como campo informativo em product_costs,
-- só pra poder separar a tela "Custo de cada peça — Exclusivos" em um
-- painel por coleção (Creature Within, Crimson Veil, Curse Mark, etc.) —
-- 43 peças misturadas numa lista só ficou difícil de navegar.
-- ============================================================================

alter table product_costs add column if not exists collection text;
