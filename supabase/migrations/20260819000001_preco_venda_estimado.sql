-- ============================================================================
-- Preço de venda planejado por peça — só existe pra calcular lucro
-- ESTIMADO de peças que ainda não venderam nada (sem venda real, não tem
-- gross_amount de sale_revenue pra puxar). Fica null até o admin
-- preencher; o cálculo em cima dele acontece no client (não precisa de
-- view nova — é só custo direto + taxas sobre esse preço hipotético,
-- sem rateio de marketing/fixo, que só faz sentido em cima de venda
-- real do mês).
-- ============================================================================

alter table product_costs add column if not exists preco_venda numeric(10,2);
