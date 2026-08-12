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

## Webhook da Shopify — o que falta pra ligar de verdade

Código pronto em `supabase/functions/shopify-webhook/index.ts`. Recebe
`orders/paid`, `orders/cancelled` e `refunds/create` e mantém
`sale_revenue` atualizada (upsert idempotente por `shopify_order_id` +
`shopify_line_item_id` — a Shopify pode reenviar o mesmo webhook mais de
uma vez, então não pode duplicar).

**Pra ativar, falta só:**

1. Alguém com acesso admin da loja Shopify precisa criar um app
   custom/private com escopo de leitura de pedidos, pra gerar um webhook
   secret.
2. Configurar o secret no projeto:
   ```
   npx supabase secrets set SHOPIFY_WEBHOOK_SECRET=<secret> --project-ref vatoeojxpejefxqslgli
   ```
3. Fazer o deploy da function:
   ```
   npx supabase functions deploy shopify-webhook --project-ref vatoeojxpejefxqslgli
   ```
   Isso devolve uma URL (algo como
   `https://vatoeojxpejefxqslgli.supabase.co/functions/v1/shopify-webhook`).
4. Na Shopify, registrar **três** webhooks apontando pra essa mesma URL,
   um pra cada tópico: `orders/paid`, `orders/cancelled`, `refunds/create`.

**Coisa importante pra funcionar direito**: o SKU cadastrado em "Custo de
cada peça" precisa ser **exatamente igual** ao SKU real da peça na
Shopify — é assim que o sistema liga uma venda ao custo dela. SKU errado
não dá erro, só faz o custo direto daquela venda virar zero silenciosamente
(lucro aparente maior do que o real). Pra evitar digitar SKU errado, o
próprio `shopify-webhook` já cria a linha da peça sozinho (SKU + nome
certos, direto do payload) na primeira venda daquele SKU — o admin só
precisa preencher os números de custo depois. As peças criadas assim
aparecem com o selo "custo zerado" na tela até alguém preencher.

## Importar o catálogo da Shopify antes de qualquer venda

Código pronto em
`supabase/functions/shopify-import-products/index.ts`. Em vez de esperar
o `shopify-webhook` ir descobrindo peça por peça conforme elas vendem,
essa function busca o catálogo inteiro da Shopify de uma vez (API de
Produtos, com paginação) e cria todas as linhas de uma vez em
`product_costs` — custo zerado, prontas pro Vitor preencher com calma
antes do webhook começar a ligar vendas de verdade. Não sobrescreve
custo já preenchido (`ignoreDuplicates`), então dá pra rodar de novo
sempre que a loja tiver produto novo.

Precisa das mesmas credenciais admin da Shopify do webhook, mais um
token de API com escopo `read_products` (pode ser o mesmo app custom,
só marcando esse escopo a mais):

```
npx supabase secrets set SHOPIFY_STORE_DOMAIN=sua-loja.myshopify.com --project-ref vatoeojxpejefxqslgli
npx supabase secrets set SHOPIFY_ADMIN_API_TOKEN=<token, escopo read_products> --project-ref vatoeojxpejefxqslgli
npx supabase secrets set ADMIN_IMPORT_SECRET=<qualquer string longa e aleatória> --project-ref vatoeojxpejefxqslgli
npx supabase functions deploy shopify-import-products --project-ref vatoeojxpejefxqslgli
```

Pra disparar a importação (não é automático, chama quando quiser):

```
curl -X POST https://vatoeojxpejefxqslgli.supabase.co/functions/v1/shopify-import-products \
  -H "Authorization: Bearer <ADMIN_IMPORT_SECRET>"
```

## Próximos passos

1. Ligar o webhook e importar o catálogo de verdade (ver seções acima) —
   depende de acesso à Shopify.
2. Tela pra gerenciar `admin_emails` (hoje só dá pra editar via SQL Editor
   ou CLI).
3. Seletor de mês no dashboard/admin — hoje sempre mostra o mês corrente;
   os botões "7d" / "Trimestre" e as setas do `month-picker` ainda são só
   visuais.
4. Reembolso parcial de item com desconto aplicado pode não bater 100%
   com o valor original (a function usa o preço do item no refund, não
   recalcula rateio de desconto por item) — ok pro volume normal, vale
   revisar se começar a ter muito reembolso parcial complexo.
