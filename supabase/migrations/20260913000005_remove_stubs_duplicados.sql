-- ============================================================================
-- Apaga os stubs duplicados de "Custo de cada peça".
--
-- Quatro peças do Drop Básico apareciam duas vezes no painel: uma linha com o
-- shopify_product_id da loja básico (bloco 90099…, com todas as vendas e o
-- custo cadastrado) e outra com o id da loja exclusivo (bloco 1032633…, que
-- lista o mesmo catálogo). A segunda virou stub no import, nunca vendeu uma
-- unidade e ficou com custo zerado — só poluía o painel.
--
-- O delete é guardado: só remove linha que continua com custo zero E sem
-- nenhuma venda associada. Se alguma dessas peças tiver vendido pela loja
-- exclusivo entre a consulta e a execução, a linha não é apagada.
--
-- Se um dia entrar venda por um desses ids, o webhook recria o stub com custo
-- zero — e aí o selo "sem custo" no Lucro por peça denuncia, que é pra isso
-- que ele existe.
-- ============================================================================

delete from product_costs pc
where pc.shopify_product_id in (
    10326336241976,  -- Calça Cargo Premium Moletom - MM Basic Drop
    10326336143672,  -- Camiseta De Compressão - MM Basic Drop
    10326336176440,  -- Camiseta Regular - MM Basic Drop
    10326336209208   -- Moletom Zip Up Com Touca - MM Basic Drop
  )
  and (pc.tecido + pc.estampa + pc.costura + pc.outros_acabamentos) = 0
  and not exists (
    select 1 from sale_revenue sr where sr.shopify_product_id = pc.shopify_product_id
  );
