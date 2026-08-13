# Lucro Líquido — Mental Madness

Calcula a margem real de cada venda (faturamento → custo direto → custos da
venda → marketing rateado → fixos rateados → lucro líquido).

Mudança em relação à proposta original: em vez de sincronizar vendas a
partir do Projeto A (painel de comissionamento), esse projeto recebe as
vendas direto de um webhook da própria Shopify. Motivo: o Projeto A só
enxerga venda com cupom de afiliado, e o lucro líquido precisa de
**todas** as vendas — com ou sem cupom. De brinde, o payload da Shopify já
vem com SKU e preço por item, então não precisa mexer no schema do
Projeto A pra resolver isso. Ver `lucro-liquido-arquitetura.html` pra
proposta original (o desenho de custo em 4 camadas continua igual, só a
origem do dado de venda mudou).

Stack: Vite + React 19 + TypeScript + react-router-dom + @supabase/supabase-js
— mesma stack do `mental-madness-mvp`, pra ficar familiar.

## Estado atual

- **Projeto Supabase real criado e linkado** (`vatoeojxpejefxqslgli`), com o
  schema e os dados de exemplo já aplicados.
- **Schema pronto** (`supabase/migrations/`): tabelas `sale_revenue`,
  `product_costs`, `sale_fee_rates`, `monthly_overhead` e as views
  `sale_margin` / `monthly_dre` que fazem o cálculo de margem.
- **Autenticação pronta**: login por e-mail e senha (Supabase Auth,
  confirmação de e-mail desligada). Só quem está na tabela `admin_emails`
  consegue ler/editar as tabelas sensíveis — hoje são `vitor@m3ntalmadness.com`
  e `lucas@hinfros.com.br`. Rotas `/` e `/admin` redirecionam pra `/login` se
  ninguém estiver autenticado.
- **Telas conectadas ao banco de verdade** (`src/lib/queries.ts`): dashboard
  lê `monthly_dre`, `sale_margin` e `monthly_overhead` do mês atual; admin lê
  e edita `monthly_overhead`, `sale_fee_rates` e `product_costs` — as edições
  gravam no Supabase na hora (sem botão de "salvar tudo", cada campo salva
  sozinho ao perder o foco). Não existe mais dado mockado no projeto.

## Primeiro acesso

1. Abrir `/login`, clicar em "Primeiro acesso? Criar conta".
2. Usar um e-mail que já esteja em `admin_emails` (`vitor@m3ntalmadness.com`
   ou `lucas@hinfros.com.br`) e escolher uma senha (mínimo 6 caracteres) — a
   conta é criada e o login já libera na hora, sem confirmação por e-mail.
3. Nas próximas vezes, é só "Entrar" com esse e-mail e senha.

Estar logado não basta pra ver custo/margem — o e-mail precisa estar na
tabela `admin_emails`. Pra liberar outra pessoa, inserir o e-mail dela lá
(via SQL Editor do Supabase, ou `npx supabase db query --linked "insert into admin_emails (email) values ('...')"`;
não existe tela pra isso ainda).

## Rodar localmente

```
npm install
npm run dev
```

Copiar `.env.example` pra `.env` e preencher com a URL e a anon key do
projeto (já feito neste ambiente).

## Webhook da Shopify — ativo

Código em `supabase/functions/shopify-webhook/index.ts`. Recebe
`orders/paid`, `orders/cancelled` e `refunds/create` e mantém
`sale_revenue` atualizada (upsert idempotente por `shopify_order_id` +
`shopify_line_item_id` — a Shopify pode reenviar o mesmo webhook mais de
uma vez, então não pode duplicar).

**Já implantado e com os 3 webhooks registrados** na loja
`m3ntalmadness.myshopify.com`, apontando pra
`https://vatoeojxpejefxqslgli.supabase.co/functions/v1/shopify-webhook`.

App usado: "Basic JackPot" (custom app criado via Shopify Dev Dashboard —
modelo 2026, sem Partner Organization, só permissão de app-development na
loja). Credenciais (`SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`,
`SHOPIFY_STORE_DOMAIN`, `SHOPIFY_WEBHOOK_SECRET`) já configuradas como
secrets no projeto Supabase.

**Como o matching peça↔venda funciona:** por `shopify_variant_id`, não
por SKU — a loja não tem SKU cadastrado em nenhuma variante na Shopify
(`"sku": null` em toda a API), então usar SKU deixaria toda venda sem
custo batido. `shopify_variant_id` sempre existe (gerado pela própria
Shopify) e é a chave real de `product_costs` agora; o campo SKU continua
existindo na tela "Custo de cada peça", mas é só informativo/opcional, não
tem mais função no cálculo. `product_costs.id` (uuid) é a chave usada por
todas as edições no admin (custo, nome, linha, SKU, exclusão).

O próprio `shopify-webhook` cria a linha da peça sozinho (variant_id +
nome certos, direto do payload da Shopify) na primeira venda daquele
variant_id — o admin só precisa preencher os números de custo depois. As
peças criadas assim aparecem com o selo "custo zerado" na tela até
alguém preencher.

## Importar o catálogo da Shopify — automático

Código em `supabase/functions/shopify-import-products/index.ts`. Busca só
os produtos da coleção **"Basic MM Drop"** na Shopify (API de Produtos,
com paginação) e cria uma linha **por peça** (não por variante — P/M/G
compartilham o mesmo custo) em `product_costs`, custo zerado. Não
sobrescreve custo já preenchido (`ignoreDuplicates`), então roda de novo
sem bagunçar nada.

**Roda sozinha todo dia às 6h UTC (3h da manhã em Brasília)**, via
`pg_cron` + `pg_net` (migração `20260812000007_schedule_import.sql`).
Assim, todo produto novo que o Vitor publicar na Shopify dentro da
coleção "Basic MM Drop" aparece na tela "Custo de cada peça" no dia
seguinte, sem precisar ninguém lembrar de rodar nada na mão. Os
"Exclusivos" continuam entrando pelo jeito de sempre: o `shopify-webhook`
cria a linha sozinho na primeira venda de cada um.

O secret usado pelo cron pra chamar a function fica no **Supabase Vault**
(`admin_import_secret`), não em texto puro em nenhum arquivo — só o nome
do secret aparece na migração.

Pra rodar manualmente também (ex: testar um produto novo sem esperar até
amanhã):
```
curl -X POST https://vatoeojxpejefxqslgli.supabase.co/functions/v1/shopify-import-products \
  -H "Authorization: Bearer <ADMIN_IMPORT_SECRET>"
```

## Próximos passos

1. Vitor preencher o custo direto das peças já importadas (aba "Custo de
   cada peça" no admin — estão zeradas até alguém preencher).
2. Confirmar que uma venda real cai certinho no dashboard depois do
   webhook registrado (checar depois da próxima venda da loja).
3. Tela pra gerenciar `admin_emails` (hoje só dá pra editar via SQL Editor
   ou CLI).
4. Seletor de mês no dashboard/admin — hoje sempre mostra o mês corrente;
   os botões "7d" / "Trimestre" e as setas do `month-picker` ainda são só
   visuais.
5. Reembolso parcial de item com desconto aplicado pode não bater 100%
   com o valor original (a function usa o preço do item no refund, não
   recalcula rateio de desconto por item) — ok pro volume normal, vale
   revisar se começar a ter muito reembolso parcial complexo.
