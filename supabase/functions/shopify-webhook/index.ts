// Recebe os webhooks da Shopify (orders/paid, orders/cancelled,
// refunds/create) e mantém `sale_revenue` atualizada — sem depender do
// Projeto A, então pega venda com ou sem cupom de afiliado.
//
// Duas lojas Shopify diferentes mandam webhook pra essa mesma URL: uma
// só com o Drop Básico, outra só com os Exclusivos. Cada uma assina o
// webhook com o Client Secret do respectivo app, então a verificação
// tenta os dois secrets — o que bater identifica de qual loja veio (e
// portanto qual product_line usar ao criar a linha de custo na primeira
// venda de um produto novo).
//
// Configuração necessária antes de registrar o webhook na Shopify:
//   npx supabase secrets set SHOPIFY_CLIENT_SECRET_BASICO=<secret do app da loja básico> --project-ref <ref>
//   npx supabase secrets set SHOPIFY_CLIENT_SECRET_EXCLUSIVO=<secret do app da loja exclusivos> --project-ref <ref>
// (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem por padrão em toda
// Edge Function, não precisa configurar.)
//
// Em CADA UMA das duas lojas (Settings → Notifications → Webhooks, ou via
// Admin API), registrar três webhooks apontando pra essa mesma URL:
//   orders/paid, orders/cancelled, refunds/create
// (o formato é JSON; a função decide o que fazer olhando o header
// X-Shopify-Topic.)

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

type ProductLine = "basico" | "exclusivo";

const STORE_SECRETS: { secret: string; productLine: ProductLine }[] = [
  { secret: Deno.env.get("SHOPIFY_CLIENT_SECRET_BASICO") ?? "", productLine: "basico" },
  { secret: Deno.env.get("SHOPIFY_CLIENT_SECRET_EXCLUSIVO") ?? "", productLine: "exclusivo" },
].filter((s) => s.secret);

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function computeHmac(rawBody: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

// Testa a assinatura contra os secrets das duas lojas — devolve qual
// product_line bateu, ou null se nenhuma bateu (assinatura inválida).
async function identifyStore(rawBody: string, hmacHeader: string | null): Promise<ProductLine | null> {
  if (!hmacHeader) return null;
  for (const { secret, productLine } of STORE_SECRETS) {
    const computed = await computeHmac(rawBody, secret);
    if (timingSafeEqual(computed, hmacHeader)) return productLine;
  }
  return null;
}

interface ShopifyLineItem {
  id: number;
  product_id: number | null;
  sku: string | null;
  title: string;
  variant_title?: string | null;
  name?: string;
  quantity: number;
  price: string;
}

interface ShopifyOrder {
  id: number;
  processed_at?: string;
  created_at: string;
  line_items: ShopifyLineItem[];
}

interface ShopifyRefundLineItem {
  line_item_id: number;
  quantity: number;
  line_item?: { price: string };
}

interface ShopifyRefund {
  order_id: number;
  refund_line_items: ShopifyRefundLineItem[];
}

async function handleOrderPaid(supabase: SupabaseClient, order: ShopifyOrder, productLine: ProductLine) {
  // Casa a venda com o custo da peça pelo product_id, não pelo SKU nem
  // pelo variant_id — a loja não tem SKU cadastrado em nenhum produto na
  // Shopify, e o custo (tecido/estampa/costura) é o mesmo pra qualquer
  // tamanho da mesma peça, então o custo é por produto, não por variante.
  const rows = (order.line_items ?? [])
    .filter((item) => !!item.product_id)
    .map((item) => ({
      shopify_order_id: order.id,
      shopify_line_item_id: item.id,
      shopify_product_id: item.product_id as number,
      product_sku: item.sku,
      product_name: item.variant_title ? `${item.title} - ${item.variant_title}` : (item.title ?? item.name ?? "Sem nome"),
      quantity: item.quantity,
      gross_amount: Number(item.price) * item.quantity,
      sale_date: order.processed_at ?? order.created_at,
    }));

  if (rows.length === 0) return;

  const { error } = await supabase
    .from("sale_revenue")
    .upsert(rows, { onConflict: "shopify_order_id,shopify_line_item_id" });
  if (error) throw error;

  await ensureProductCostStubs(
    supabase,
    (order.line_items ?? [])
      .filter((item) => !!item.product_id)
      .map((item) => ({
        shopify_product_id: item.product_id as number,
        product_sku: item.sku,
        product_name: item.title ?? item.name ?? "Sem nome",
      })),
    productLine,
  );
}

// Cria a linha da peça em `product_costs` na primeira venda que aparecer
// com aquele product_id — custo tudo zerado, só o nome certo (veio
// direto da Shopify, sem o tamanho/variante) e a linha certa (básico ou
// exclusivo, conforme qual das duas lojas mandou o webhook). O admin só
// precisa preencher os números depois.
async function ensureProductCostStubs(
  supabase: SupabaseClient,
  saleRows: { shopify_product_id: number; product_sku: string | null; product_name: string }[],
  productLine: ProductLine,
) {
  const uniqueByProduct = new Map(saleRows.map((r) => [r.shopify_product_id, { sku: r.product_sku, product_name: r.product_name }]));
  const stubs = Array.from(uniqueByProduct, ([shopify_product_id, { sku, product_name }]) => ({
    shopify_product_id,
    sku,
    product_name,
    product_line: productLine,
    tecido: 0,
    estampa: 0,
    costura: 0,
    outros_acabamentos: 0,
  }));

  const { error } = await supabase
    .from("product_costs")
    .upsert(stubs, { onConflict: "shopify_product_id", ignoreDuplicates: true });
  if (error) throw error;
}

async function handleOrderCancelled(supabase: SupabaseClient, order: { id: number }) {
  const { error } = await supabase.from("sale_revenue").delete().eq("shopify_order_id", order.id);
  if (error) throw error;
}

async function handleRefundCreate(supabase: SupabaseClient, refund: ShopifyRefund) {
  for (const item of refund.refund_line_items ?? []) {
    const unitPrice = Number(item.line_item?.price ?? 0);

    const { data: existing, error: fetchError } = await supabase
      .from("sale_revenue")
      .select("quantity, gross_amount")
      .eq("shopify_order_id", refund.order_id)
      .eq("shopify_line_item_id", item.line_item_id)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!existing) continue;

    const newQuantity = Math.max(0, existing.quantity - item.quantity);
    const newGross = Math.max(0, Number(existing.gross_amount) - unitPrice * item.quantity);

    if (newQuantity === 0) {
      const { error } = await supabase
        .from("sale_revenue")
        .delete()
        .eq("shopify_order_id", refund.order_id)
        .eq("shopify_line_item_id", item.line_item_id);
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from("sale_revenue")
        .update({ quantity: newQuantity, gross_amount: newGross })
        .eq("shopify_order_id", refund.order_id)
        .eq("shopify_line_item_id", item.line_item_id);
      if (error) throw error;
    }
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Método não permitido", { status: 405 });
  }

  const rawBody = await req.text();
  const hmacHeader = req.headers.get("X-Shopify-Hmac-Sha256");
  const topic = req.headers.get("X-Shopify-Topic") ?? "";

  const productLine = await identifyStore(rawBody, hmacHeader);
  if (!productLine) {
    return new Response("Assinatura inválida", { status: 401 });
  }

  const payload = JSON.parse(rawBody);
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    if (topic === "orders/paid") {
      await handleOrderPaid(supabase, payload as ShopifyOrder, productLine);
    } else if (topic === "orders/cancelled") {
      await handleOrderCancelled(supabase, payload as { id: number });
    } else if (topic === "refunds/create") {
      await handleRefundCreate(supabase, payload as ShopifyRefund);
    } else {
      return new Response(`Tópico não tratado: ${topic}`, { status: 200 });
    }
  } catch (error) {
    console.error(error);
    return new Response("Erro ao processar webhook", { status: 500 });
  }

  return new Response("ok", { status: 200 });
});
