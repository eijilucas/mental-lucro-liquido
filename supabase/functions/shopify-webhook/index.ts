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
  { secret: Deno.env.get("SHOPIFY_CLIENT_SECRET_BASICO") ?? "", productLine: "basico" as const },
  { secret: Deno.env.get("SHOPIFY_CLIENT_SECRET_EXCLUSIVO") ?? "", productLine: "exclusivo" as const },
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
  total_discount?: string | null;
  discount_allocations?: { amount: string }[];
  gift_card?: boolean;
}

interface ShopifyDiscountCode {
  code: string;
}

interface ShopifyMoneySet {
  shop_money?: { amount?: string };
}

interface ShopifyOrder {
  id: number;
  order_number?: number;
  processed_at?: string;
  created_at: string;
  cancelled_at?: string | null;
  line_items: ShopifyLineItem[];
  discount_codes?: ShopifyDiscountCode[];
  payment_gateway_names?: string[];
  total_shipping_price_set?: ShopifyMoneySet;
  shipping_lines?: { price?: string }[];
}

// Frete cobrado do cliente no checkout — valor fixo por estado (SP 30, AC 90…).
// Prefere total_shipping_price_set (já com desconto de frete aplicado); cai pra
// soma das shipping_lines se a loja não mandar o set.
function shippingRevenue(order: ShopifyOrder): number {
  const fromSet = Number(order.total_shipping_price_set?.shop_money?.amount);
  if (Number.isFinite(fromSet)) return fromSet;
  return (order.shipping_lines ?? []).reduce((sum, l) => sum + (Number(l.price) || 0), 0);
}

// Desconto real do item: `price` da Shopify é sempre o preço de tabela, o
// cupom entra à parte. Cupom aplicado no pedido inteiro chega rateado em
// discount_allocations; desconto direto na linha vem em total_discount.
// Os dois juntos nunca aparecem preenchidos pro mesmo desconto, então
// preferimos o rateio quando existe pra não contar duas vezes.
function lineDiscount(item: ShopifyLineItem): number {
  const allocated = (item.discount_allocations ?? []).reduce((sum, d) => sum + (Number(d.amount) || 0), 0);
  if (allocated > 0) return allocated;
  return Number(item.total_discount) || 0;
}

// Qualquer gateway com "pix" no nome (o app que processa Pix varia por
// loja). Pago só com vale-presente não passa por gateway nenhum, então não
// paga taxa de cartão nem antifraude. O resto (cartão, boleto, vale + cartão)
// cai como "cartao" — o pedido não diz quanto foi pago em cada meio.
function detectPaymentMethod(order: ShopifyOrder): "pix" | "cartao" | "vale_presente" {
  const names = order.payment_gateway_names ?? [];
  if (names.some((n) => /pix/i.test(n))) return "pix";
  if (names.length > 0 && names.every((n) => /gift_?card/i.test(n))) return "vale_presente";
  return "cartao";
}

// Compra de vale-presente não é receita: é dinheiro adiantado que vira venda
// quando o vale é usado — e aí o pedido pago com ele já entra normalmente.
// Gravar a compra também contava a mesma receita duas vezes.
function isGiftCard(item: ShopifyLineItem): boolean {
  return item.gift_card === true || /gift\s*card/i.test(item.title ?? item.name ?? "");
}

interface ShopifyRefundLineItem {
  line_item_id: number;
  quantity: number;
  line_item?: { price: string };
}

interface ShopifyRefund {
  id: number;
  order_id: number;
  refund_line_items: ShopifyRefundLineItem[];
}

async function handleOrderPaid(supabase: SupabaseClient, order: ShopifyOrder, productLine: ProductLine) {
  // A Shopify não garante ordem de entrega dos webhooks. Pedido pago e
  // cancelado em poucos minutos pode chegar como orders/cancelled ANTES de
  // orders/paid — nesse caso handleOrderCancelled roda sem ter o que apagar,
  // e depois orders/paid gravaria a venda sem que nenhum evento futuro venha
  // limpar. O próprio payload de orders/paid já diz se o pedido está
  // cancelado (cancelled_at), então checa aqui em vez de confiar só na ordem
  // de chegada dos eventos.
  if (order.cancelled_at) {
    await handleOrderCancelled(supabase, order);
    return;
  }

  // Casa a venda com o custo da peça pelo product_id, não pelo SKU nem
  // pelo variant_id — a loja não tem SKU cadastrado em nenhum produto na
  // Shopify, e o custo (tecido/estampa/costura) é o mesmo pra qualquer
  // tamanho da mesma peça, então o custo é por produto, não por variante.
  const hasCoupon = (order.discount_codes?.length ?? 0) > 0;
  const paymentMethod = detectPaymentMethod(order);

  // O payload traz a quantidade ORIGINAL de cada item. Se um reembolso desse
  // pedido já foi aplicado (orders/paid reenviado pela Shopify, ou entregue
  // depois do refunds/create), gravar isso desfaria o reembolso — então
  // desconta o que já foi devolvido, igual o shopify-import-orders faz.
  const devolvido = await refundedByLineItem(supabase, order.id);

  const rows = (order.line_items ?? [])
    .filter((item) => !!item.product_id && !isGiftCard(item))
    .map((item) => {
      const refunded = devolvido.get(item.id);
      const quantity = Math.max(0, item.quantity - (refunded?.quantity ?? 0));
      return {
        shopify_order_id: order.id,
        shopify_line_item_id: item.id,
        shopify_product_id: item.product_id as number,
        product_sku: item.sku,
        product_name: item.variant_title ? `${item.title} - ${item.variant_title}` : (item.title ?? item.name ?? "Sem nome"),
        quantity,
        gross_amount: Math.max(0, Number(item.price) * item.quantity - (refunded?.amount ?? 0)),
        // Desconto acompanha as unidades que sobraram depois do reembolso.
        discount_amount: item.quantity > 0 ? Number((lineDiscount(item) * (quantity / item.quantity)).toFixed(2)) : 0,
        sale_date: order.processed_at ?? order.created_at,
        has_coupon: hasCoupon,
        payment_method: paymentMethod,
      };
    })
    .filter((row) => row.quantity > 0);

  if (rows.length === 0) return;

  const { error } = await supabase
    .from("sale_revenue")
    .upsert(rows, { onConflict: "shopify_order_id,shopify_line_item_id" });
  if (error) throw error;

  // Frete cobrado do pedido — a coluna `cost` (frete real pago) é preenchida
  // separado pelo shipping-cost-callback, por isso não vai no payload aqui.
  const { error: shipError } = await supabase.from("order_shipping").upsert(
    {
      shopify_order_id: order.id,
      order_number: order.order_number != null ? String(order.order_number) : null,
      revenue: shippingRevenue(order),
      revenue_synced_at: new Date().toISOString(),
    },
    { onConflict: "shopify_order_id" },
  );
  if (shipError) throw shipError;

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

// Produtos que nunca são peça de roupa de verdade (gift card, pingente)
// não ganham linha de custo automática. Pingente continua entrando como
// venda; gift card já nem chega aqui (ver isGiftCard).
const EXCLUDED_NAME_PATTERNS = [/gift\s*card/i, /pingente/i];

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

async function handleOrderCancelled(supabase: SupabaseClient, order: { id: number }) {
  const { error } = await supabase.from("sale_revenue").delete().eq("shopify_order_id", order.id);
  if (error) throw error;
  const { error: shipError } = await supabase.from("order_shipping").delete().eq("shopify_order_id", order.id);
  if (shipError) throw shipError;
}

// Soma, por item, o que os reembolsos já aplicados desse pedido devolveram
// (aplicar_reembolso_shopify guarda os itens de cada um).
async function refundedByLineItem(supabase: SupabaseClient, orderId: number) {
  const { data, error } = await supabase
    .from("shopify_refunds_aplicados")
    .select("itens")
    .eq("shopify_order_id", orderId);
  if (error) throw error;

  const byLineItem = new Map<number, { quantity: number; amount: number }>();
  for (const refund of data ?? []) {
    for (const item of (refund.itens ?? []) as { line_item_id: number; quantity: number; unit_price: number }[]) {
      const entry = byLineItem.get(Number(item.line_item_id)) ?? { quantity: 0, amount: 0 };
      entry.quantity += Number(item.quantity) || 0;
      entry.amount += (Number(item.unit_price) || 0) * (Number(item.quantity) || 0);
      byLineItem.set(Number(item.line_item_id), entry);
    }
  }
  return byLineItem;
}

// A Shopify pode entregar o mesmo refunds/create mais de uma vez. Subtrair
// direto do que está gravado descontava o reembolso de novo a cada reenvio,
// então a conta roda no banco (aplicar_reembolso_shopify), que registra o id
// do reembolso na mesma transação e ignora um id já aplicado. Lá também o
// desconto acompanha as unidades que sobraram — devolveu metade das peças,
// devolveu metade do cupom junto.
async function handleRefundCreate(supabase: SupabaseClient, refund: ShopifyRefund) {
  if (!refund.id) throw new Error("refunds/create sem id do reembolso");

  const { error } = await supabase.rpc("aplicar_reembolso_shopify", {
    p_refund_id: refund.id,
    p_order_id: refund.order_id,
    p_itens: (refund.refund_line_items ?? []).map((item) => ({
      line_item_id: item.line_item_id,
      quantity: item.quantity,
      unit_price: Number(item.line_item?.price ?? 0),
    })),
  });
  if (error) throw error;
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
