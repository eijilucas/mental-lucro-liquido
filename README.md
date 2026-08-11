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

## Próximos passos

1. Escrever a function agendada que sincroniza `sale_revenue` a partir de
   `sales` / `sale_items` do Projeto A, 1×/hora, somente leitura.
2. **Pendência de dado**: `sale_items` no Projeto A hoje só tem
   `product_name` e `quantity` — não tem SKU nem valor por item. Para
   `sale_revenue` funcionar por SKU (como o schema espera), ou o Projeto A
   passa a gravar SKU + valor por item, ou a sincronização distribui o
   `gross_amount` da venda entre os itens por alguma regra a combinar.
3. Tela pra gerenciar `admin_emails` (hoje só dá pra editar via SQL Editor
   ou CLI).
4. Seletor de mês no dashboard/admin — hoje sempre mostra o mês corrente;
   os botões "7d" / "Trimestre" e as setas do `month-picker` ainda são só
   visuais.
