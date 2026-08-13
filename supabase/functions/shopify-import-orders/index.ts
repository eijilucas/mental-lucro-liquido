// Traz pedidos históricos das duas lojas Shopify pra `sale_revenue` —
// serve pra preencher o mês corrente com os pedidos que já existiam
// ANTES do shopify-webhook começar a capturar sozinho. Reaplica a mesma
// lógica de custo/reembolso do webhook (idempotente por
// shopify_order_id + shopify_line_item_id, então rodar de novo não
// duplica nada e não atropela vendas que o webhook já capturou).
//
// Não é um webhook — é disparada manualmente, com um POST protegido por
// secret próprio (reusa o mesmo ADMIN_IMPORT_SECRET do
// shopify-import-products).
//
// Deploy:
//   npx supabase functions deploy shopify-import-orders --project-ref <ref>
//
// Disparar (traz pedidos desde a data informada, das duas lojas):
//   curl -X POST https://<ref>.supabase.co/functions/v1/shopify-import-orders \
//     -H "Authorization: Bearer <ADMIN_IMPORT_SECRET>" \
//     -H "Content-Type: application/json" \
//     -d '{"since": "2026-08-01T00:00:00-03:00"}'

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const ADMIN_IMPORT_SECRET = Deno.env.get("ADMIN_IMPORT_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SHOPIFY_API_VERSION = "2025-01";

type ProductLine = "basico" | "exclusivo";

interface StoreProfile {
  productLine: ProductLine;
  domain: string;
  clientId: string;
  clientSecret: string;
}

const STORE_PROFILES: StoreProfile[] = [
  {
    productLine: "basico",
    domain: Deno.env.get("SHOPIFY_STORE_DOMAIN_BASICO") ?? "",
    clientId: Deno.env.get("SHOPIFY_CLIENT_ID_BASICO") ?? "",
    clientSecret: Deno.env.get("SHOPIFY_CLIENT_SECRET_BASICO") ?? "",
  },
  {
    productLine: "exclusivo",
    domain: Deno.env.get("SHOPIFY_STORE_DOMAIN_EXCLUSIVO") ?? "",
    clientId: Deno.env.get("SHOPIFY_CLIENT_ID_EXCLUSIVO") ?? "",
    clientSecret: Deno.env.get("SHOPIFY_CLIENT_SECRET_EXCLUSIVO") ?? "",
  },
].filter((p) => p.domain && p.clientId && p.clientSecret);

// Pedidos com esses financial_status contam como venda (mesmo que
// parcial ou já reembolsada — o valor final já sai ajustado abaixo).
// "pending" e "voided" ficam de fora (nunca foi pago de verdade).
const COUNTABLE_FINANCIAL_STATUS = new Set(["paid", "partially_paid", "partially_refunded", "refunded"]);

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

interface ShopifyRefundLineItem {
  line_item_id: number;
  quantity: number;
  line_item?: { price: string };
}

interface ShopifyRefund {
  refund_line_items: ShopifyRefundLineItem[];
}

interface ShopifyOrder {
  id: number;
  processed_at?: string;
  created_at: string;
  cancelled_at: string | null;
  financial_status: string;
  line_items: ShopifyLineItem[];
  refunds: ShopifyRefund[];
}

interface SaleRow {
  shopify_order_id: number;
  shopify_line_item_id: number;
  shopify_product_id: number;
  product_sku: string | null;
  product_name: string;
  quantity: number;
  gross_amount: number;
  sale_date: string;
}

function extractNextUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const nextPart = linkHeader.split(",").find((part) => part.includes('rel="next"'));
  if (!nextPart) return null;
  const match = nextPart.match(/<([^>]+)>/);
  return match ? match[1] : null;
}

async function fetchAccessToken(profile: StoreProfile): Promise<string> {
  const res = await fetch(`https://${profile.domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: profile.clientId,
      client_secret: profile.clientSecret,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) throw new Error(`Shopify (${profile.domain}) respondeu ${res.status} ao gerar token de acesso`);
  const data = await res.json();
  return data.access_token as string;
}

async function fetchOrdersSince(profile: StoreProfile, accessToken: string, since: string): Promise<ShopifyOrder[]> {
  const orders: ShopifyOrder[] = [];
  let url: string | null =
    `https://${profile.domain}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&created_at_min=${encodeURIComponent(since)}&limit=250`;

  while (url) {
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": accessToken } });
    if (!res.ok) throw new Error(`Shopify (${profile.domain}) respondeu ${res.status} ao listar pedidos`);
    const data = await res.json();
    orders.push(...(data.orders ?? []));
    url = extractNextUrl(res.headers.get("Link"));
  }

  return orders;
}

// Monta a linha de venda por item já com qualquer reembolso parcial
// aplicado (mesmo ajuste que o webhook faria em duas etapas — aqui dá
// pra fazer de uma vez só, já que o pedido inteiro está disponível).
function buildSaleRows(order: ShopifyOrder): SaleRow[] {
  const refundedByLineItem = new Map<number, { quantity: number; amount: number }>();
  for (const refund of order.refunds ?? []) {
    for (const item of refund.refund_line_items ?? []) {
      const unitPrice = Number(item.line_item?.price ?? 0);
      const entry = refundedByLineItem.get(item.line_item_id) ?? { quantity: 0, amount: 0 };
      entry.quantity += item.quantity;
      entry.amount += unitPrice * item.quantity;
      refundedByLineItem.set(item.line_item_id, entry);
    }
  }

  return (order.line_items ?? [])
    .filter((item) => !!item.product_id)
    .map((item) => {
      const refunded = refundedByLineItem.get(item.id);
      const quantity = Math.max(0, item.quantity - (refunded?.quantity ?? 0));
      const gross_amount = Math.max(0, Number(item.price) * item.quantity - (refunded?.amount ?? 0));
      return {
        shopify_order_id: order.id,
        shopify_line_item_id: item.id,
        shopify_product_id: item.product_id as number,
        product_sku: item.sku,
        product_name: item.variant_title ? `${item.title} - ${item.variant_title}` : (item.title ?? item.name ?? "Sem nome"),
        quantity,
        gross_amount,
        sale_date: order.processed_at ?? order.created_at,
      };
    })
    .filter((row) => row.quantity > 0);
}

// Produtos que nunca são peça de roupa de verdade (gift card, pingente)
// — a venda continua sendo registrada normalmente, só não ganham uma
// linha de custo automática.
const EXCLUDED_NAME_PATTERNS = [/gift\s*card/i, /pingente/i];

async function ensureProductCostStubs(
  supabase: SupabaseClient,
  saleRows: { shopify_product_id: number; product_sku: string | null; product_name: string }[],
  productLine: ProductLine,
) {
  const eligible = saleRows.filter((r) => !EXCLUDED_NAME_PATTERNS.some((re) => re.test(r.product_name)));
  const uniqueByProduct = new Map(eligible.map((r) => [r.shopify_product_id, { sku: r.product_sku, product_name: r.product_name }]));
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

async function importOrdersFromProfile(supabase: SupabaseClient, profile: StoreProfile, since: string): Promise<number> {
  const accessToken = await fetchAccessToken(profile);
  const orders = await fetchOrdersSince(profile, accessToken, since);

  const rows: SaleRow[] = [];
  for (const order of orders) {
    if (order.cancelled_at) continue;
    if (!COUNTABLE_FINANCIAL_STATUS.has(order.financial_status)) continue;
    rows.push(...buildSaleRows(order));
  }

  if (rows.length === 0) return 0;

  const { error } = await supabase
    .from("sale_revenue")
    .upsert(rows, { onConflict: "shopify_order_id,shopify_line_item_id" });
  if (error) throw error;

  await ensureProductCostStubs(supabase, rows, profile.productLine);

  return rows.length;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Método não permitido", { status: 405 });
  }

  const authHeader = req.headers.get("Authorization");
  if (!ADMIN_IMPORT_SECRET || authHeader !== `Bearer ${ADMIN_IMPORT_SECRET}`) {
    return new Response("Não autorizado", { status: 401 });
  }

  if (STORE_PROFILES.length === 0) {
    return new Response("Nenhuma loja Shopify configurada", { status: 500 });
  }

  let since = "";
  try {
    const body = await req.json();
    since = body?.since ?? "";
  } catch {
    // corpo vazio é ok se "since" não for enviado — vira erro abaixo
  }
  if (!since) {
    return new Response('Informe {"since": "AAAA-MM-DDTHH:mm:ss-03:00"} no corpo do POST', { status: 400 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const counts: Record<string, number> = {};
    for (const profile of STORE_PROFILES) {
      counts[profile.productLine] = await importOrdersFromProfile(supabase, profile, since);
    }
    return new Response(JSON.stringify({ ok: true, itens_importados: counts }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
