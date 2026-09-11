// Casa etiquetas da Melhor Envio com pedidos da Shopify e preenche o custo
// real de frete em order_shipping.cost.
//
// Por que existe: o mm-etiquetas só entrou no ar em meados de agosto/2026, então
// 346 pedidos de julho e do começo de agosto nunca tiveram o custo da etiqueta
// empurrado — entravam na DRE cobrando frete do cliente e pagando R$ 0,00. O
// histórico real está na conta da Melhor Envio, mas o dump da ME não traz
// número de pedido, só destinatário e CEP. Quem tem nome e CEP por pedido é a
// Shopify, e a credencial dela vive aqui — daí o casamento acontecer nesta
// função, e não do lado do mm-etiquetas.
//
// Auth: bearer ADMIN_IMPORT_SECRET (mesmo padrão do shopify-import-orders).
//
// Deploy:
//   npx supabase functions deploy match-shipping-costs --project-ref vatoeojxpejefxqslgli
//
// Disparar (dryRun não escreve nada, só devolve o relatório):
//   curl -X POST https://<ref>.supabase.co/functions/v1/match-shipping-costs \
//     -H "Authorization: Bearer <ADMIN_IMPORT_SECRET>" \
//     -H "Content-Type: application/json" \
//     -d '{"dryRun": true, "labels": [...]}'
//
// Nunca sobrescreve custo que já existe: pedido que já tem cost preenchido
// entra no relatório como divergência (com os dois valores) em vez de ser
// atualizado no escuro.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const ADMIN_IMPORT_SECRET = Deno.env.get("ADMIN_IMPORT_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SHOPIFY_API_VERSION = "2025-01";

// Janela de casamento: a etiqueta é comprada depois do pedido, mas não muito
// depois. 2 dias de folga pra trás cobre fuso/pré-postagem.
const MAX_DIAS_DEPOIS = 60;
const MAX_DIAS_ANTES = 2;

interface StoreProfile {
  domain: string;
  clientId: string;
  clientSecret: string;
}

const STORE_PROFILES: StoreProfile[] = [
  {
    domain: Deno.env.get("SHOPIFY_STORE_DOMAIN_BASICO") ?? "",
    clientId: Deno.env.get("SHOPIFY_CLIENT_ID_BASICO") ?? "",
    clientSecret: Deno.env.get("SHOPIFY_CLIENT_SECRET_BASICO") ?? "",
  },
  {
    domain: Deno.env.get("SHOPIFY_STORE_DOMAIN_EXCLUSIVO") ?? "",
    clientId: Deno.env.get("SHOPIFY_CLIENT_ID_EXCLUSIVO") ?? "",
    clientSecret: Deno.env.get("SHOPIFY_CLIENT_SECRET_EXCLUSIVO") ?? "",
  },
].filter((p) => p.domain && p.clientId && p.clientSecret);

interface MeLabel {
  id?: string;
  protocol?: string;
  status?: string;
  paid_at?: string;
  price?: number | string;
  to_name?: string;
  to_postal_code?: string;
}

interface ShopifyOrder {
  id: number;
  order_number?: number;
  created_at: string;
  processed_at?: string;
  cancelled_at?: string | null;
  shipping_address?: { name?: string; first_name?: string; last_name?: string; zip?: string } | null;
  customer?: { first_name?: string; last_name?: string } | null;
}

interface Candidate {
  id: number;
  orderNumber: string;
  date: number;
  usado: boolean;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// O dump da ME veio com acento duplo-encodado ("VinÃ­cius"). Sem desfazer isso
// antes de tirar acento, "Ã­" vira "A" e o nome nunca casa com a Shopify.
function fixMojibake(s: string): string {
  if (!/[ÃÂ][-¿]/.test(s)) return s;
  try {
    const bytes = Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return s;
  }
}

function normalizeName(s: string | undefined): string {
  return fixMojibake(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCep(s: string | undefined): string {
  return (s ?? "").replace(/\D/g, "").padStart(8, "0").slice(-8);
}

function matchKey(name: string | undefined, cep: string | undefined): string {
  return `${normalizeName(name)}|${normalizeCep(cep)}`;
}

function orderRecipient(order: ShopifyOrder): string {
  const addr = order.shipping_address;
  if (!addr) return "";
  if (addr.name) return addr.name;
  const composed = [addr.first_name, addr.last_name].filter(Boolean).join(" ");
  if (composed) return composed;
  return [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(" ");
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
  if (!res.ok) throw new Error(`OAuth (${profile.domain}) respondeu ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

async function fetchOrders(profile: StoreProfile, since: string): Promise<ShopifyOrder[]> {
  const token = await fetchAccessToken(profile);
  const orders: ShopifyOrder[] = [];
  let url: string | null =
    `https://${profile.domain}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any` +
    `&created_at_min=${encodeURIComponent(since)}&limit=250` +
    `&fields=id,order_number,created_at,processed_at,cancelled_at,shipping_address,customer`;

  while (url) {
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
    if (!res.ok) throw new Error(`Shopify (${profile.domain}) respondeu ${res.status} ao listar pedidos`);
    const data = await res.json();
    orders.push(...(data.orders ?? []));
    url = extractNextUrl(res.headers.get("Link"));
  }
  return orders;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  if (!ADMIN_IMPORT_SECRET || auth !== `Bearer ${ADMIN_IMPORT_SECRET}`) {
    return json({ error: "unauthorized" }, 401);
  }
  if (STORE_PROFILES.length === 0) return json({ error: "nenhuma_loja_configurada" }, 500);

  let body: { labels?: MeLabel[]; dryRun?: boolean; since?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const labels = (body.labels ?? []).filter(
    (l) => l.paid_at && l.status !== "canceled" && Number.isFinite(Number(l.price)),
  );
  if (labels.length === 0) return json({ error: "sem_etiquetas_validas" }, 400);

  // Busca os pedidos a partir da etiqueta mais antiga menos a janela — pedido
  // sempre vem antes da etiqueta.
  const maisAntiga = labels
    .map((l) => Date.parse(l.paid_at!.replace(" ", "T")))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  const since = body.since ?? new Date(maisAntiga - MAX_DIAS_DEPOIS * 86400000).toISOString();

  try {
    const orders: ShopifyOrder[] = [];
    for (const profile of STORE_PROFILES) {
      orders.push(...(await fetchOrders(profile, since)));
    }

    const index = new Map<string, Candidate[]>();
    for (const o of orders) {
      if (o.cancelled_at) continue;
      const key = matchKey(orderRecipient(o), o.shipping_address?.zip);
      if (key === "|00000000") continue;
      const entry: Candidate = {
        id: o.id,
        orderNumber: o.order_number != null ? String(o.order_number) : "",
        date: Date.parse(o.processed_at ?? o.created_at),
        usado: false,
      };
      const list = index.get(key);
      if (list) list.push(entry);
      else index.set(key, [entry]);
    }

    const custoPorPedido = new Map<number, { total: number; etiquetas: string[] }>();
    const semCasamento: { protocol?: string; to_name?: string; paid_at?: string; price: number }[] = [];
    let reusados = 0;

    const ordenadas = [...labels].sort(
      (a, b) => Date.parse(a.paid_at!.replace(" ", "T")) - Date.parse(b.paid_at!.replace(" ", "T")),
    );

    for (const label of ordenadas) {
      const pago = Date.parse(label.paid_at!.replace(" ", "T"));
      const candidatos = (index.get(matchKey(label.to_name, label.to_postal_code)) ?? []).filter(
        (c) =>
          Number.isFinite(c.date) &&
          pago - c.date <= MAX_DIAS_DEPOIS * 86400000 &&
          c.date - pago <= MAX_DIAS_ANTES * 86400000,
      );
      if (candidatos.length === 0) {
        semCasamento.push({
          protocol: label.protocol,
          to_name: fixMojibake(label.to_name ?? ""),
          paid_at: label.paid_at,
          price: Number(label.price),
        });
        continue;
      }

      // Cliente que comprou duas vezes tem duas etiquetas: dá preferência pro
      // pedido ainda não usado, pra não empilhar as duas no mesmo. Se todos já
      // foram usados, soma no mais próximo (pedido com etiqueta reemitida).
      const porProximidade = [...candidatos].sort(
        (a, b) => Math.abs(pago - a.date) - Math.abs(pago - b.date),
      );
      const escolhido = porProximidade.find((c) => !c.usado) ?? porProximidade[0];
      if (escolhido.usado) reusados++;
      escolhido.usado = true;

      const atual = custoPorPedido.get(escolhido.id) ?? { total: 0, etiquetas: [] };
      atual.total += Number(label.price);
      atual.etiquetas.push(label.protocol ?? label.id ?? "");
      custoPorPedido.set(escolhido.id, atual);
    }

    const supabase: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const ids = [...custoPorPedido.keys()];
    const existentes = new Map<number, number | null>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await supabase
        .from("order_shipping")
        .select("shopify_order_id, cost")
        .in("shopify_order_id", ids.slice(i, i + 200));
      if (error) throw error;
      for (const row of data ?? []) existentes.set(Number(row.shopify_order_id), row.cost);
    }

    const paraEscrever: { shopify_order_id: number; cost: number; cost_synced_at: string }[] = [];
    const divergencias: { shopify_order_id: number; custo_atual: number; custo_melhor_envio: number }[] = [];
    const foraDoJackpot: number[] = [];
    const agora = new Date().toISOString();

    for (const [id, { total }] of custoPorPedido) {
      const custo = Number(total.toFixed(2));
      if (!existentes.has(id)) {
        // Pedido que a ME entregou mas que não está em order_shipping — pedido
        // de outra origem ou fora do período importado. Não inventa linha.
        foraDoJackpot.push(id);
        continue;
      }
      const atual = existentes.get(id);
      if (atual === null || atual === undefined) {
        paraEscrever.push({ shopify_order_id: id, cost: custo, cost_synced_at: agora });
      } else if (Math.abs(Number(atual) - custo) > 0.01) {
        divergencias.push({ shopify_order_id: id, custo_atual: Number(atual), custo_melhor_envio: custo });
      }
    }

    if (!body.dryRun && paraEscrever.length > 0) {
      for (let i = 0; i < paraEscrever.length; i += 200) {
        const lote = paraEscrever.slice(i, i + 200);
        const { error } = await supabase
          .from("order_shipping")
          .upsert(lote, { onConflict: "shopify_order_id" });
        if (error) throw error;
      }
    }

    return json({
      ok: true,
      dryRun: !!body.dryRun,
      etiquetas_recebidas: labels.length,
      pedidos_shopify_no_periodo: orders.length,
      etiquetas_sem_casamento: semCasamento.length,
      pedidos_casados: custoPorPedido.size,
      etiquetas_somadas_no_mesmo_pedido: reusados,
      custo_gravado_em: paraEscrever.length,
      valor_total_gravado: Number(paraEscrever.reduce((s, r) => s + r.cost, 0).toFixed(2)),
      divergencias_ignoradas: divergencias.length,
      divergencias: divergencias.slice(0, 20),
      pedidos_fora_do_jackpot: foraDoJackpot.length,
      amostra_sem_casamento: semCasamento.slice(0, 15),
    });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
