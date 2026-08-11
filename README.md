# Lucro Líquido — Mental Madness

Projeto B da proposta de arquitetura: calcula a margem real de cada venda
(faturamento → custo direto → custos da venda → marketing rateado → fixos
rateados → lucro líquido), sem tocar no projeto de comissionamento
(Projeto A). Ver `lucro-liquido-arquitetura.html` para a proposta original.

Stack: Vite + React 19 + TypeScript + react-router-dom + @supabase/supabase-js
— mesma stack do `mental-madness-mvp`, pra ficar familiar.

## Estado atual

- **Schema pronto** (`supabase/migrations/0001_schema.sql`): tabelas
  `sale_revenue`, `product_costs`, `sale_fee_rates`, `monthly_overhead` e as
  views `sale_margin` / `monthly_dre` que fazem o cálculo de margem.
- **Telas prontas**, rodando com dados mockados (`src/data/mockData.ts`):
  dashboard (`/`) e admin (`/admin`).
- **Ainda não existe**: projeto Supabase real, function de sincronização com
  o Projeto A, nem conexão das telas com dados reais.

## Rodar localmente

```
npm install
npm run dev
```

Abre em `/` (dashboard) e `/admin` (custos e taxas).

## Próximos passos

1. Criar o projeto Supabase novo e rodar `supabase/migrations/0001_schema.sql`
   (e opcionalmente `supabase/seed.sql` para ter dados de teste).
2. Preencher `.env` (copiar de `.env.example`) com a URL e a anon key do
   projeto novo, e trocar `src/data/mockData.ts` por chamadas reais via
   `src/lib/supabase.ts`.
3. Escrever a function agendada que sincroniza `sale_revenue` a partir de
   `sales` / `sale_items` do Projeto A, 1×/hora, somente leitura.
4. **Pendência de dado**: `sale_items` no Projeto A hoje só tem
   `product_name` e `quantity` — não tem SKU nem valor por item. Para
   `sale_revenue` funcionar por SKU (como o schema espera), ou o Projeto A
   passa a gravar SKU + valor por item, ou a sincronização distribui o
   `gross_amount` da venda entre os itens por alguma regra a combinar.
5. Autenticação: as policies de RLS assumem um `role: admin` no JWT do
   usuário logado — falta decidir como esse usuário (Vitor) faz login.
