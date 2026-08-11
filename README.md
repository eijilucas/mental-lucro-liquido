# Lucro Líquido — Mental Madness

Projeto B da proposta de arquitetura: calcula a margem real de cada venda
(faturamento → custo direto → custos da venda → marketing rateado → fixos
rateados → lucro líquido), sem tocar no projeto de comissionamento
(Projeto A). Ver `lucro-liquido-arquitetura.html` para a proposta original.

Stack: Vite + React 19 + TypeScript + react-router-dom + @supabase/supabase-js
— mesma stack do `mental-madness-mvp`, pra ficar familiar.

## Estado atual

- **Projeto Supabase real criado e linkado** (`vatoeojxpejefxqslgli`), com o
  schema e os dados de exemplo já aplicados.
- **Schema pronto** (`supabase/migrations/`): tabelas `sale_revenue`,
  `product_costs`, `sale_fee_rates`, `monthly_overhead` e as views
  `sale_margin` / `monthly_dre` que fazem o cálculo de margem.
- **Autenticação pronta**: login por e-mail e senha (Supabase Auth). Só quem
  está na tabela `admin_emails` consegue ler as tabelas sensíveis — hoje é só
  `vitor@m3ntalmadness.com`. Rotas `/` e `/admin` redirecionam pra `/login`
  se ninguém estiver autenticado.
- **Telas prontas**, mas ainda rodando com dados mockados
  (`src/data/mockData.ts`) — só a autenticação está de verdade, os números
  do dashboard/admin ainda não vêm do banco.

## Primeiro acesso do Vitor

1. Abrir `/login`, clicar em "Primeiro acesso? Criar conta".
2. Digitar `vitor@m3ntalmadness.com` e escolher uma senha (mínimo 6
   caracteres) — a conta é criada na hora, sem precisar de ninguém aprovar.
3. Se o projeto tiver confirmação de e-mail ativada (padrão do Supabase),
   confirmar pelo e-mail antes de conseguir entrar.
4. Nas próximas vezes, é só "Entrar" com esse e-mail e senha.

Estar logado não basta pra ver custo/margem — o e-mail precisa estar na
tabela `admin_emails`. Pra liberar outra pessoa, inserir o e-mail dela lá
(via SQL Editor do Supabase; não existe tela pra isso ainda).

## Rodar localmente

```
npm install
npm run dev
```

Copiar `.env.example` pra `.env` e preencher com a URL e a anon key do
projeto (já feito neste ambiente). Sem isso as rotas ficam abertas e usam
só os dados mockados.

## Próximos passos

1. Trocar `src/data/mockData.ts` por consultas reais via `src/lib/supabase.ts`
   (`sale_margin`, `monthly_dre`, e as tabelas do admin).
2. Escrever a function agendada que sincroniza `sale_revenue` a partir de
   `sales` / `sale_items` do Projeto A, 1×/hora, somente leitura.
3. **Pendência de dado**: `sale_items` no Projeto A hoje só tem
   `product_name` e `quantity` — não tem SKU nem valor por item. Para
   `sale_revenue` funcionar por SKU (como o schema espera), ou o Projeto A
   passa a gravar SKU + valor por item, ou a sincronização distribui o
   `gross_amount` da venda entre os itens por alguma regra a combinar.
4. Tela pra gerenciar `admin_emails` (hoje só dá pra editar via SQL Editor).
