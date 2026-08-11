-- ============================================================================
-- Autenticação — lista de e-mails que podem logar como admin.
-- Login é por e-mail e senha do Supabase Auth (self-service signup — sem
-- precisar da service_role key pra criar a conta). Estar autenticado não
-- basta: `is_admin_user()` só libera as tabelas sensíveis pra quem também
-- está nesta lista.
-- ============================================================================

create table if not exists admin_emails (
  email text primary key,
  created_at timestamptz not null default now()
);

alter table admin_emails enable row level security;
-- Nenhuma policy de select/insert/update/delete pra client autenticado:
-- só quem tem acesso ao SQL Editor / Service Role mexe nesta tabela.

insert into admin_emails (email) values ('vitor@m3ntalmadness.com')
on conflict (email) do nothing;

create or replace function is_admin_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from admin_emails where email = auth.jwt() ->> 'email'
  );
$$;
