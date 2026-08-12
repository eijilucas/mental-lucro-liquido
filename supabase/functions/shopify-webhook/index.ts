// Recebe os webhooks da Shopify (orders/paid, orders/cancelled,
// refunds/create) e mantém `sale_revenue` atualizada — sem depender do
// Projeto A, então pega venda com ou sem cupom de afiliado.
//
// Configuração necessária antes de registrar o webhook na Shopify:
//   npx supabase secrets set SHOPIFY_WEBHOOK_SECRET=<secret da Shopify> --project-ref <ref>
// (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem por padrão em toda
// Edge Function, não precisa configurar.)
//
// Na Shopify (Settings → Notifications → Webhooks, ou via Admin API),
// registrar três webhooks apontando pra essa mesma URL:
//   orders/paid, orders/cancelled, refunds/create
// (o formato é JSON; a função decide o que fazer olhando o header
// X-Shopify-Topic.)

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const SHOPIFY_WEBHOOK_SECRET = Deno.env.get("SHOPIFY_WEBHOOK_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyHmac(rawBody: string, hmacHeader: string | null): Promise<boolean> {
  if (!hmacHeader || !SHOPIFY_WEBHOOK_SECRET) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SHOPIFY_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const computed = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return timingSafeEqual(computed, hmacHeader);
}

interface ShopifyLineItem {
  id: number;
  sku: string | null;
  title: string;
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

async function handleOrderPaid(supabase: SupabaseClient, order: ShopifyOrder) {
  const rows = (order.line_items ?? [])
    .filter((item) => !!item.sku)
    .map((item) => ({
      shopify_order_id: order.id,
      shopify_line_item_id: item.id,
      product_sku: item.sku as string,
      product_name: item.title ?? item.name ?? "Sem nome",
      quantity: item.quantity,
      gross_amount: Number(item.price) * item.quantity,
      sale_date: order.processed_at ?? order.created_at,
    }));

  if (rows.length === 0) return;

  const { error } = await supabase
    .from("sale_revenue")
    .upsert(rows, { onConflict: "shopify_order_id,shopify_line_item_id" });
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

  if (!(await verifyHmac(rawBody, hmacHeader))) {
    return new Response("Assinatura inválida", { status: 401 });
  }

  const payload = JSON.parse(rawBody);
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    if (topic === "orders/paid") {
      await handleOrderPaid(supabase, payload as ShopifyOrder);
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
