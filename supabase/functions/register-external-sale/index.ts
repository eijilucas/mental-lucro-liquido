// Recebe as vendas do "Vendas Externas" (pedidos WhatsApp/Discord/Instagram
// que nunca passam pelo checkout da Shopify) e mantém sale_revenue
// atualizada — as linhas entram com source='external'.
//
// Contrato: mental-madness-vendas-externas/docs/api-contracts/07-jackpot-lucro-liquido.md
//
// Auth: bearer secret compartilhado (EXTERNAL_SALE_SECRET), mesmo padrão do
// shopify-import-products. Quem chama é a Edge Function register-jackpot-sale
// do Vendas Externas, não um usuário logado.
//
// Configuração:
//   npx supabase secrets set EXTERNAL_SALE_SECRET=<secret> --project-ref vatoeojxpejefxqslgli
// (o mesmo valor tem que estar setado no projeto do Vendas Externas.)
//
// POST   → registra/atualiza a venda (substitui a lista de itens inteira).
// DELETE → apaga a venda toda (pedido excluído no Vendas Externas).

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EXPECTED_SECRET = Deno.env.get("EXTERNAL_SALE_SECRET") ?? "";

// Mesma exclusão do shopify-webhook: gift card não tem custo de produção,
// não ganha linha de custo automática. Pingente ganha.
const EXCLUDED_NAME_PATTERNS = [/gift\s*card/i];

interface ItemInput {
  externalItemId: string;
  shopifyProductId: number | null;
  productName: string;
  productLine: "basico" | "exclusivo" | null;
  quantity: number;
  grossAmount: number;
}

interface PostBody {
  externalOrderId: string;
  saleDate: string;
  hasCoupon: boolean;
  items: ItemInput[];
  // Frete cobrado do cliente nessa venda. Campo novo do lado do Vendas
  // Externas — pedido antigo não tem, e aí a linha de frete não é tocada
  // (o custo da etiqueta vem separado, pelo shipping-cost-callback).
  shippingRevenue?: number | string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "DELETE") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!EXPECTED_SECRET || token !== EXPECTED_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  if (req.method === "DELETE") {
    let body: { externalOrderId?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    if (!body.externalOrderId) return json({ error: "external_order_id_required" }, 400);

    const { data, error } = await supabase
      .from("sale_revenue")
      .delete()
      .eq("source", "external")
      .eq("external_order_id", body.externalOrderId)
      .select("id");
    if (error) {
      console.error("register-external-sale DELETE:", error);
      return json({ error: "delete_failed" }, 500);
    }

    const { error: shipErr } = await supabase
      .from("order_shipping")
      .delete()
      .eq("external_order_id", body.externalOrderId);
    if (shipErr) console.error("register-external-sale DELETE frete:", shipErr);

    return json({ ok: true, deleted: data?.length ?? 0 });
  }

  let body: PostBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!body.externalOrderId || !Array.isArray(body.items)) {
    return json({ error: "missing_fields" }, 400);
  }

  // Substitui a lista inteira: remove itens que sumiram numa edição do pedido.
  const keep = new Set(body.items.map((i) => i.externalItemId));
  const { data: existing, error: exErr } = await supabase
    .from("sale_revenue")
    .select("external_item_id")
    .eq("source", "external")
    .eq("external_order_id", body.externalOrderId);
  if (exErr) {
    console.error("register-external-sale existing lookup:", exErr);
    return json({ error: "lookup_failed" }, 500);
  }
  const toDelete = (existing ?? [])
    .map((r) => r.external_item_id as string)
    .filter((id) => !keep.has(id));
  if (toDelete.length > 0) {
    const { error: delErr } = await supabase
      .from("sale_revenue")
      .delete()
      .eq("source", "external")
      .eq("external_order_id", body.externalOrderId)
      .in("external_item_id", toDelete);
    if (delErr) {
      console.error("register-external-sale cleanup:", delErr);
      return json({ error: "cleanup_failed" }, 500);
    }
  }

  const rows = body.items.map((it) => ({
    source: "external",
    external_order_id: body.externalOrderId,
    external_item_id: it.externalItemId,
    shopify_order_id: null,
    shopify_line_item_id: null,
    shopify_product_id: it.shopifyProductId,
    product_sku: null,
    product_name: it.productName,
    quantity: it.quantity,
    gross_amount: it.grossAmount,
    sale_date: body.saleDate,
    has_coupon: body.hasCoupon,
    payment_method: "pix",
  }));

  if (rows.length > 0) {
    const { error: upErr } = await supabase
      .from("sale_revenue")
      .upsert(rows, { onConflict: "external_order_id,external_item_id" });
    if (upErr) {
      console.error("register-external-sale upsert:", upErr);
      return json({ error: "upsert_failed" }, 500);
    }

    // Frete cobrado. Só grava quando o campo vem no payload — pedido antigo,
    // de antes de esse campo existir, não deve virar "cobrou zero".
    const frete = body.shippingRevenue;
    if (frete !== undefined && frete !== null && frete !== "") {
      const valor = Number(frete);
      if (Number.isFinite(valor)) {
        const { error: shipErr } = await supabase.from("order_shipping").upsert(
          {
            external_order_id: body.externalOrderId,
            revenue: valor,
            revenue_synced_at: new Date().toISOString(),
          },
          { onConflict: "external_order_id" },
        );
        if (shipErr) console.error("register-external-sale frete:", shipErr);
      }
    }

    // Stub de custo pra produto ainda não visto (mesma lógica do
    // shopify-webhook / ensureProductCostStubs).
    const stubs = [
      ...new Map(
        body.items
          .filter(
            (it) => it.shopifyProductId && !EXCLUDED_NAME_PATTERNS.some((re) => re.test(it.productName)),
          )
          .map((it) => [
            it.shopifyProductId,
            {
              shopify_product_id: it.shopifyProductId,
              product_name: it.productName,
              // Sempre 'external' — vira linha própria em "Custo de cada peça".
              // Só cria stub quando o produto ainda não existe (ignoreDuplicates
              // abaixo), então produto que já vende pela Shopify não é afetado.
              product_line: "external",
              tecido: 0,
              estampa: 0,
              costura: 0,
              outros_acabamentos: 0,
            },
          ]),
      ).values(),
    ];
    if (stubs.length > 0) {
      const { error: stubErr } = await supabase
        .from("product_costs")
        .upsert(stubs, { onConflict: "shopify_product_id", ignoreDuplicates: true });
      if (stubErr) console.error("register-external-sale stubs:", stubErr);
    }
  }

  return json({ ok: true, rows: rows.length });
});
