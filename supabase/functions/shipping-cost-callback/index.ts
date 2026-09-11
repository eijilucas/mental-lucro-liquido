// Recebe do mm-etiquetas o custo REAL da etiqueta por pedido (o valor que a
// Melhor Envio debitou da carteira) e grava em order_shipping.cost. É o que
// entra como despesa de frete na DRE — o outro lado (frete cobrado do cliente)
// vem da Shopify pelo shopify-webhook.
//
// Auth: HMAC-SHA256 hex do corpo cru no header X-Signature, mesmo padrão do
// integration-callback do mm-etiquetas (signHmacHex). Secret compartilhado em
// SHIPPING_COST_CALLBACK_SECRET (= LUCRO_LIQUIDO_CALLBACK_SECRET no mm-etiquetas).
// Deploy sem verify_jwt — o HMAC é a autenticação.
//
// Idempotente: o mm-etiquetas reenvia a cada reprocess/retry do pipeline. O
// upsert por shopify_order_id só reescreve as colunas presentes no payload,
// nunca mexe em revenue.
//
// Configuração:
//   npx supabase functions deploy shipping-cost-callback --no-verify-jwt --project-ref vatoeojxpejefxqslgli
//   npx supabase secrets set SHIPPING_COST_CALLBACK_SECRET=<secret> --project-ref vatoeojxpejefxqslgli
//
// Body (valor_frete e diferenca_frete são opcionais e independentes):
//   { "shopify_order_id": "5834923...", "order_number": "3511",
//     "valor_frete": 22.16,        // preço da etiqueta na compra
//     "diferenca_frete": 61.92 }   // reajuste de conferência da Melhor Envio (débito), soma acumulada

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CALLBACK_SECRET = Deno.env.get("SHIPPING_COST_CALLBACK_SECRET") ?? "";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function hmacHex(rawBody: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface Body {
  shopify_order_id?: string | number;
  valor_frete?: number | string;
  diferenca_frete?: number | string;
  order_number?: string | number;
}

function parseAmount(v: number | string | undefined | null): number | null | undefined {
  if (v === undefined) return undefined; // campo ausente → não mexe na coluna
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!CALLBACK_SECRET) return json({ error: "not_configured" }, 503);

  const rawBody = await req.text();
  const signature = req.headers.get("X-Signature") ?? "";
  const expected = await hmacHex(rawBody, CALLBACK_SECRET);
  if (!signature || !timingSafeEqual(signature, expected)) {
    return json({ error: "invalid_signature" }, 401);
  }

  let body: Body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const orderId = Number(body.shopify_order_id);
  if (!Number.isFinite(orderId) || orderId <= 0) return json({ error: "invalid_shopify_order_id" }, 400);

  const cost = parseAmount(body.valor_frete);
  const adjustment = parseAmount(body.diferenca_frete);
  if (cost === undefined && "valor_frete" in body) return json({ error: "invalid_valor_frete" }, 400);
  if (adjustment === undefined && "diferenca_frete" in body) return json({ error: "invalid_diferenca_frete" }, 400);

  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    shopify_order_id: orderId,
    order_number: body.order_number != null ? String(body.order_number) : null,
  };
  if (cost !== undefined) {
    row.cost = cost;
    row.cost_synced_at = now;
  }
  if (adjustment !== undefined) {
    row.cost_adjustment = adjustment;
    row.adjustment_synced_at = now;
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { error } = await supabase.from("order_shipping").upsert(row, { onConflict: "shopify_order_id" });
  if (error) {
    console.error("shipping-cost-callback upsert:", error);
    return json({ error: "upsert_failed" }, 500);
  }

  return json({ ok: true, shopify_order_id: orderId, cost: cost ?? null, adjustment: adjustment ?? null });
});
