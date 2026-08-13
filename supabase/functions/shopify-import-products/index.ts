// Importa o catálogo de produtos da coleção "Basic MM Drop" da Shopify
// pra `product_costs`, criando as linhas que ainda não existem (uma por
// PEÇA, não por variante — P/M/G da mesma peça compartilham o mesmo
// custo de tecido/estampa/costura, então uma linha só evita repetição e
// é como o admin realmente pensa o custo). Rodar isso ANTES do webhook
// começar a receber vendas deixa o admin com o catálogo pronto pra
// preencher custo, em vez de ir descobrindo peça por peça conforme
// vendem.
//
// Só importa produtos da coleção configurada — os "Exclusivos" entram
// pelo mesmo jeito que sempre entraram: o shopify-webhook cria a linha
// sozinho na primeira venda daquele produto.
//
// Não é um webhook — é disparada manualmente (uma vez, ou de vez em
// quando pra pegar produto novo), com um POST protegido por secret
// próprio (não usa o SHOPIFY_WEBHOOK_SECRET, porque isso aqui não vem
// da Shopify, é você chamando a função).
//
// Configuração necessária (modelo de app custom via Dev Dashboard, 2026):
// o token de acesso da Admin API expira em 24h, então a função gera um
// novo sozinha a cada execução via Client Credentials Grant, usando o
// Client ID/Secret do app (esses não expiram).
//   npx supabase secrets set SHOPIFY_STORE_DOMAIN=sua-loja.myshopify.com --project-ref <ref>
//   npx supabase secrets set SHOPIFY_CLIENT_ID=<ID do cliente do app> --project-ref <ref>
//   npx supabase secrets set SHOPIFY_CLIENT_SECRET=<chave secreta do app> --project-ref <ref>
//   npx supabase secrets set ADMIN_IMPORT_SECRET=<qualquer string longa e aleatória> --project-ref <ref>
//
// Deploy:
//   npx supabase functions deploy shopify-import-products --project-ref <ref>
//
// Disparar a importação:
//   curl -X POST https://<ref>.supabase.co/functions/v1/shopify-import-products \
//     -H "Authorization: Bearer <ADMIN_IMPORT_SECRET>"

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const ADMIN_IMPORT_SECRET = Deno.env.get("ADMIN_IMPORT_SECRET") ?? "";
const SHOPIFY_STORE_DOMAIN = Deno.env.get("SHOPIFY_STORE_DOMAIN") ?? "";
const SHOPIFY_CLIENT_ID = Deno.env.get("SHOPIFY_CLIENT_ID") ?? "";
const SHOPIFY_CLIENT_SECRET = Deno.env.get("SHOPIFY_CLIENT_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Handle da coleção "Basic MM Drop" na Shopify — só produtos dela entram
// nessa importação em massa.
const COLLECTION_HANDLE = Deno.env.get("SHOPIFY_IMPORT_COLLECTION_HANDLE") ?? "basic-mm-drop";

async function fetchAccessToken(): Promise<string> {
  const res = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    throw new Error(`Shopify respondeu ${res.status} ao gerar token de acesso`);
  }
  const data = await res.json();
  return data.access_token as string;
}

// Versão da API REST da Shopify — confira em shopify.dev se ainda é
// suportada na hora de configurar; elas saem trimestralmente.
const SHOPIFY_API_VERSION = "2025-01";

interface ShopifyVariant {
  id: number;
  sku: string | null;
}

interface ShopifyProduct {
  id: number;
  title: string;
  variants: ShopifyVariant[];
}

interface ProductCostStub {
  shopify_product_id: number;
  sku: string | null;
  product_name: string;
  tecido: number;
  estampa: number;
  costura: number;
  sacolinha: number;
  adesivo: number;
  outros_acabamentos: number;
}

function extractNextUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const nextPart = linkHeader.split(",").find((part) => part.includes('rel="next"'));
  if (!nextPart) return null;
  const match = nextPart.match(/<([^>]+)>/);
  return match ? match[1] : null;
}

async function fetchCollectionId(accessToken: string): Promise<number> {
  const res = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/custom_collections.json?handle=${COLLECTION_HANDLE}&fields=id,handle`,
    { headers: { "X-Shopify-Access-Token": accessToken } },
  );
  if (!res.ok) {
    throw new Error(`Shopify respondeu ${res.status} ao buscar a coleção "${COLLECTION_HANDLE}"`);
  }
  const data = await res.json();
  const collection = data.custom_collections?.[0];
  if (!collection) {
    throw new Error(`Coleção "${COLLECTION_HANDLE}" não encontrada na Shopify`);
  }
  return collection.id as number;
}

async function fetchCollectionProducts(accessToken: string, collectionId: number): Promise<ShopifyProduct[]> {
  const products: ShopifyProduct[] = [];
  let url: string | null =
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/products.json?collection_id=${collectionId}&limit=250`;

  while (url) {
    const res = await fetch(url, {
      headers: { "X-Shopify-Access-Token": accessToken },
    });
    if (!res.ok) {
      throw new Error(`Shopify respondeu ${res.status} ao listar produtos da coleção`);
    }
    const data = await res.json();
    products.push(...(data.products ?? []));
    url = extractNextUrl(res.headers.get("Link"));
  }

  return products;
}

async function importProducts(supabase: SupabaseClient): Promise<number> {
  const accessToken = await fetchAccessToken();
  const collectionId = await fetchCollectionId(accessToken);
  const products = await fetchCollectionProducts(accessToken, collectionId);

  // Uma linha por PEÇA, não por variante — pega o SKU da primeira
  // variante que tiver um preenchido (se nenhuma tiver, fica null).
  const stubs: ProductCostStub[] = products.map((product) => ({
    shopify_product_id: product.id,
    sku: product.variants?.find((v) => v.sku)?.sku ?? null,
    product_name: product.title,
    tecido: 0,
    estampa: 0,
    costura: 0,
    sacolinha: 0,
    adesivo: 0,
    outros_acabamentos: 0,
  }));

  if (stubs.length === 0) return 0;

  const { error } = await supabase
    .from("product_costs")
    .upsert(stubs, { onConflict: "shopify_product_id", ignoreDuplicates: true });
  if (error) throw error;

  return stubs.length;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Método não permitido", { status: 405 });
  }

  const authHeader = req.headers.get("Authorization");
  if (!ADMIN_IMPORT_SECRET || authHeader !== `Bearer ${ADMIN_IMPORT_SECRET}`) {
    return new Response("Não autorizado", { status: 401 });
  }

  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    return new Response("SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID ou SHOPIFY_CLIENT_SECRET não configurados", { status: 500 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const count = await importProducts(supabase);
    return new Response(JSON.stringify({ ok: true, pecas_encontradas: count }), {
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
