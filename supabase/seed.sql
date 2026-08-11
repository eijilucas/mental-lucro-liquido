-- Dados de exemplo para rodar o projeto localmente antes da sincronização
-- com o Projeto A existir de verdade. Mesmos números usados nos mockups.

insert into product_costs (sku, product_name, tecido, estampa, costura, sacolinha, adesivo, outros_acabamentos) values
  ('CCP-MOL-BLK-M', 'Calça Cargo Premium Moletom', 52.00, 14.00, 9.00, 1.50, 1.00, 2.50),
  ('MOL-OVS-GRF-G', 'Moletom Oversized Grafite', 61.00, 16.00, 10.50, 1.50, 1.00, 2.00),
  ('CAM-BAS-OFF-P', 'Camiseta Basic Off-White', 18.00, 6.50, 2.50, 0.80, 0.20, 0.50),
  ('JAQ-RIP-BLK-M', 'Jaqueta Corta-Vento Ripstop', 118.00, 26.00, 18.00, 2.50, 1.50, 2.00),
  ('BON-LOG-BLK-U', 'Boné Bordado Logo', 21.00, 6.00, 2.50, 0.80, 0.20, 0.50)
on conflict (sku) do nothing;

update sale_fee_rates set
  taxa_shopify_pct = 0.0290,
  taxa_gateway_pct = 0.0349,
  imposto_pct = 0.0600,
  comissao_influencer_pct = 0.0500,
  desconto_medio_pct = 0
where id = 1;

insert into monthly_overhead (month, category, amount, is_marketing, allocation_method) values
  ('2026-08-01', 'Tráfego pago', 1480.00, true, 'per_revenue'),
  ('2026-08-01', 'Influenciadores', 752.00, true, 'per_revenue'),
  ('2026-08-01', 'Folha — Felipe, Theo, Renan', 2100.00, false, 'per_unit'),
  ('2026-08-01', 'Plataforma / domínio', 318.00, false, 'per_unit'),
  ('2026-08-01', 'Contabilidade', 210.00, false, 'per_unit'),
  ('2026-08-01', 'Internet, celular, energia', 100.00, false, 'per_unit');

insert into sale_revenue (sale_id, product_sku, product_name, quantity, gross_amount, sale_date) values
  (gen_random_uuid(), 'CCP-MOL-BLK-M', 'Calça Cargo Premium Moletom', 1, 259.99, '2026-08-09 14:20:00-03'),
  (gen_random_uuid(), 'MOL-OVS-GRF-G', 'Moletom Oversized Grafite', 1, 219.90, '2026-08-08 10:05:00-03'),
  (gen_random_uuid(), 'CAM-BAS-OFF-P', 'Camiseta Basic Off-White', 1, 89.90, '2026-08-08 09:40:00-03'),
  (gen_random_uuid(), 'JAQ-RIP-BLK-M', 'Jaqueta Corta-Vento Ripstop', 1, 349.90, '2026-08-07 19:15:00-03'),
  (gen_random_uuid(), 'BON-LOG-BLK-U', 'Boné Bordado Logo', 1, 99.90, '2026-08-06 16:50:00-03');
