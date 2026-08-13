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

## Duas lojas Shopify diferentes

Apesar do nome parecido, `m3ntalmadness.myshopify.com` e
`mental-madness-basic.myshopify.com` são **duas lojas Shopify
independentes**, cada uma com seu próprio app custom (client ID/secret):

- `m3ntalmadness.myshopify.com` → **Drop Básico** (só a coleção
  "Basic MM Drop" é importada de lá).
- `mental-madness-basic.myshopify.com` → **Exclusivos** (a loja inteira
  é importada — não tem filtro de coleção).

Tudo — webhook e importação — lida com as duas ao mesmo tempo. Os
secrets seguem o padrão `SHOPIFY_*_BASICO` / `SHOPIFY_*_EXCLUSIVO`
(`STORE_DOMAIN`, `CLIENT_ID`, `CLIENT_SECRET` de cada uma), já
configurados no projeto Supabase.

## Webhook da Shopify — ativo nas duas lojas

Código em `supabase/functions/shopify-webhook/index.ts`. Recebe
`orders/paid`, `orders/cancelled` e `refunds/create` e mantém
`sale_revenue` atualizada (upsert idempotente por `shopify_order_id` +
`shopify_line_item_id` — a Shopify pode reenviar o mesmo webhook mais de
uma vez, então não pode duplicar).

**Já implantado, com os 3 webhooks registrados nas duas lojas**,
apontando pra `https://vatoeojxpejefxqslgli.supabase.co/functions/v1/shopify-webhook`.
Como as duas mandam pra essa mesma URL, a function tenta a assinatura
HMAC contra o secret de cada loja pra descobrir de qual veio — isso
também decide se a peça criada automaticamente entra como "basico" ou
"exclusivo".

**Como o matching peça↔venda funciona:** por `shopify_product_id`, não
por SKU — nenhuma das duas lojas tem SKU cadastrado em variante nenhuma
(`"sku": null` em toda a API), então usar SKU deixaria toda venda sem
custo batido. `shopify_product_id` sempre existe (gerado pela própria
Shopify) e é a chave real de `product_costs` agora — uma linha por PEÇA,
não por variante de tamanho (P/M/G compartilham o mesmo custo de
produção). O campo SKU continua existindo na tabela, mas sumiu da tela
("Custo de cada peça") porque não tem mais função nenhuma no cálculo.
`product_costs.id` (uuid) é a chave usada por todas as edições no admin.

O próprio `shopify-webhook` cria a linha da peça sozinho (product_id +
nome certos, direto do payload) na primeira venda daquele produto — o
admin só precisa preencher os números de custo depois. As peças criadas
assim aparecem com o selo "custo zerado" na tela até alguém preencher.

## Importar o catálogo da Shopify — automático, das duas lojas

Código em `supabase/functions/shopify-import-products/index.ts`. Numa
chamada só, busca produto das duas lojas (Básico filtrado pela coleção
"Basic MM Drop", Exclusivos sem filtro) e cria uma linha **por peça**
(não por variante) em `product_costs`, custo zerado, com o
`product_line` certo pra cada uma. Não sobrescreve custo já preenchido
(`ignoreDuplicates`), então roda de novo sem bagunçar nada.

**Roda sozinha todo dia às 6h UTC (3h da manhã em Brasília)**, via
`pg_cron` + `pg_net` (migração `20260812000007_schedule_import.sql`).
Assim, todo produto novo que for publicado em qualquer uma das duas
lojas aparece na tela "Custo de cada peça" no dia seguinte, sem precisar
ninguém lembrar de rodar nada na mão.

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
