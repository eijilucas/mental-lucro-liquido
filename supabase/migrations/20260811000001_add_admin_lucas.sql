insert into admin_emails (email) values ('lucas@hinfros.com.br')
on conflict (email) do nothing;
