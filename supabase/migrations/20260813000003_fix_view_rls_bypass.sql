-- ============================================================================
-- CORREÇÃO DE SEGURANÇA: as views (sale_margin, monthly_dre,
-- sale_overhead_allocation, monthly_totals) não tinham security_invoker,
-- que é o padrão do Postgres desde sempre (mesmo na versão 15+, onde a
-- opção passou a existir, o padrão continua false). Isso significa que
-- elas rodavam com o privilégio de quem CRIOU a view (o role usado pelas
-- migrações), não de quem estava consultando — e esse role ignora RLS.
--
-- Resultado prático: RLS funcionava certinho nas tabelas de baixo
-- (product_costs, sale_revenue, sale_fee_rates, monthly_overhead — só
-- admin lê), mas qualquer usuário autenticado (inclusive alguém que
-- acabou de criar conta sozinho, já que o self-signup está ligado)
-- conseguia ler sale_margin e monthly_dre inteiros — TODAS as vendas,
-- custos e margens da empresa — sem estar em admin_emails.
--
-- Confirmado com teste direto: um JWT fake de authenticated sem estar em
-- admin_emails via 566 linhas em sale_margin e 2 em monthly_dre antes
-- desse fix; 0 depois. Testado também que vitor@m3ntalmadness.com
-- continua vendo tudo normalmente.
-- ============================================================================

alter view monthly_totals set (security_invoker = true);
alter view sale_overhead_allocation set (security_invoker = true);
alter view sale_margin set (security_invoker = true);
alter view monthly_dre set (security_invoker = true);
