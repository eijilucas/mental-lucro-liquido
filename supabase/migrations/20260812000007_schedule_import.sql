-- ============================================================================
-- Agenda a importação do catálogo (shopify-import-products) pra rodar
-- sozinha todo dia de madrugada, em vez de precisar chamar na mão sempre
-- que um produto novo do Drop Básico é publicado na Shopify.
--
-- O ADMIN_IMPORT_SECRET não fica em texto puro aqui — é guardado no
-- Supabase Vault (pgsodium) numa migração separada que não entra no
-- controle de versão, e essa aqui só referencia o nome do secret.
-- ============================================================================

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select
  cron.schedule(
    'shopify-import-products-daily',
    '0 6 * * *', -- 6h UTC = 3h da manhã no horário de Brasília
    $$
    select net.http_post(
      url := 'https://vatoeojxpejefxqslgli.supabase.co/functions/v1/shopify-import-products',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'admin_import_secret'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    );
    $$
  )
where not exists (select 1 from cron.job where jobname = 'shopify-import-products-daily');
