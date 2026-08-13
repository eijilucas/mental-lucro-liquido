// Importa o catálogo de produto de DUAS lojas Shopify diferentes pra
// `product_costs`, criando as linhas que ainda não existem (uma por
// PEÇA, não por variante — P/M/G da mesma peça compartilham o mesmo
// custo de tecido/estampa/costura, então uma linha só evita repetição e
// é como o admin realmente pensa o custo). Rodar isso deixa o admin com
// o catálogo pronto pra preencher custo, em vez de ir descobrindo peça
// por peça conforme vendem.
//
// - Loja do Drop Básico: só importa produtos da coleção "Basic MM Drop".
// - Loja dos Exclusivos: importa TODOS os produtos (é uma loja dedicada
//   só a eles, sem precisar filtrar por coleção).
//
// Não é um webhook — é disparada manualmente ou por um cron diário (ver
// migração 20260812000007_schedule_import.sql), com um POST protegido
// por secret próprio (não usa os secrets de webhook, porque isso aqui
// não vem da Shopify, é a gente chamando a function).
//
// Configuração necessária (modelo de app custom via Dev Dashboard, 2026):
// o token de acesso da Admin API expira em 24h, então a função gera um
// novo sozinha a cada execução via Client Credentials Grant, usando o
// Client ID/Secret de cada app (esses não expiram).
//   npx supabase secrets set SHOPIFY_STORE_DOMAIN_BASICO=loja-basico.myshopify.com --project-ref <ref>
//   npx supabase secrets set SHOPIFY_CLIENT_ID_BASICO=<ID do app da loja básico> --project-ref <ref>
//   npx supabase secrets set SHOPIFY_CLIENT_SECRET_BASICO=<secret do app da loja básico> --project-ref <ref>
//   npx supabase secrets set SHOPIFY_STORE_DOMAIN_EXCLUSIVO=loja-exclusivos.myshopify.com --project-ref <ref>
//   npx supabase secrets set SHOPIFY_CLIENT_ID_EXCLUSIVO=<ID do app da loja exclusivos> --project-ref <ref>
//   npx supabase secrets set SHOPIFY_CLIENT_SECRET_EXCLUSIVO=<secret do app da loja exclusivos> --project-ref <ref>
//   npx supabase secrets set ADMIN_IMPORT_SECRET=<qualquer string longa e aleatória> --project-ref <ref>
//
// Deploy:
//   npx supabase functions deploy shopify-import-products --project-ref <ref>
//
// Disparar a importação (roda as duas lojas numa chamada só):
//   curl -X POST https://<ref>.supabase.co/functions/v1/shopify-import-products \
//     -H "Authorization: Bearer <ADMIN_IMPORT_SECRET>"

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const ADMIN_IMPORT_SECRET = Deno.env.get("ADMIN_IMPORT_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Versão da API REST da Shopify — confira em shopify.dev se ainda é
// suportada na hora de configurar; elas saem trimestralmente.
const SHOPIFY_API_VERSION = "2025-01";

type ProductLine = "basico" | "exclusivo";

interface StoreProfile {
  productLine: ProductLine;
  domain: string;
  clientId: string;
  clientSecret: string;
  collectionHandle?: string;
}

const STORE_PROFILES: StoreProfile[] = [
  {
    productLine: "basico",
    domain: Deno.env.get("SHOPIFY_STORE_DOMAIN_BASICO") ?? "",
    clientId: Deno.env.get("SHOPIFY_CLIENT_ID_BASICO") ?? "",
    clientSecret: Deno.env.get("SHOPIFY_CLIENT_SECRET_BASICO") ?? "",
    collectionHandle: Deno.env.get("SHOPIFY_IMPORT_COLLECTION_HANDLE") ?? "basic-mm-drop",
  },
  {
    productLine: "exclusivo",
    domain: Deno.env.get("SHOPIFY_STORE_DOMAIN_EXCLUSIVO") ?? "",
    clientId: Deno.env.get("SHOPIFY_CLIENT_ID_EXCLUSIVO") ?? "",
    clientSecret: Deno.env.get("SHOPIFY_CLIENT_SECRET_EXCLUSIVO") ?? "",
    // sem collectionHandle: importa a loja inteira.
  },
].filter((p) => p.domain && p.clientId && p.clientSecret);

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
  product_line: ProductLine;
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
  if (!res.ok) {
    throw new Error(`Shopify (${profile.domain}) respondeu ${res.status} ao gerar token de acesso`);
  }
  const data = await res.json();
  return data.access_token as string;
}

async function fetchCollectionId(profile: StoreProfile, accessToken: string): Promise<number> {
  const res = await fetch(
    `https://${profile.domain}/admin/api/${SHOPIFY_API_VERSION}/custom_collections.json?handle=${profile.collectionHandle}&fields=id,handle`,
    { headers: { "X-Shopify-Access-Token": accessToken } },
  );
  if (!res.ok) {
    throw new Error(`Shopify (${profile.domain}) respondeu ${res.status} ao buscar a coleção "${profile.collectionHandle}"`);
  }
  const data = await res.json();
  const collection = data.custom_collections?.[0];
  if (!collection) {
    throw new Error(`Coleção "${profile.collectionHandle}" não encontrada em ${profile.domain}`);
  }
  return collection.id as number;
}

async function fetchAllProducts(profile: StoreProfile, accessToken: string, collectionId?: number): Promise<ShopifyProduct[]> {
  const products: ShopifyProduct[] = [];
  const collectionFilter = collectionId ? `&collection_id=${collectionId}` : "";
  let url: string | null =
    `https://${profile.domain}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=250${collectionFilter}`;

  while (url) {
    const res = await fetch(url, {
      headers: { "X-Shopify-Access-Token": accessToken },
    });
    if (!res.ok) {
      throw new Error(`Shopify (${profile.domain}) respondeu ${res.status} ao listar produtos`);
    }
    const data = await res.json();
    products.push(...(data.products ?? []));
    url = extractNextUrl(res.headers.get("Link"));
  }

  return products;
}

async function importFromProfile(profile: StoreProfile): Promise<ProductCostStub[]> {
  const accessToken = await fetchAccessToken(profile);
  const collectionId = profile.collectionHandle ? await fetchCollectionId(profile, accessToken) : undefined;
  const products = await fetchAllProducts(profile, accessToken, collectionId);

  // Uma linha por PEÇA, não por variante — pega o SKU da primeira
  // variante que tiver um preenchido (se nenhuma tiver, fica null).
  return products.map((product) => ({
    shopify_product_id: product.id,
    sku: product.variants?.find((v) => v.sku)?.sku ?? null,
    product_name: product.title,
    product_line: profile.productLine,
    tecido: 0,
    estampa: 0,
    costura: 0,
    sacolinha: 0,
    adesivo: 0,
    outros_acabamentos: 0,
  }));
}

async function importProducts(supabase: SupabaseClient): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  for (const profile of STORE_PROFILES) {
    const stubs = await importFromProfile(profile);
    counts[profile.productLine] = stubs.length;
    if (stubs.length === 0) continue;

    const { error } = await supabase
      .from("product_costs")
      .upsert(stubs, { onConflict: "shopify_product_id", ignoreDuplicates: true });
    if (error) throw error;
  }

  return counts;
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
    return new Response("Nenhuma loja Shopify configurada (faltam os secrets SHOPIFY_*_BASICO / SHOPIFY_*_EXCLUSIVO)", { status: 500 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const counts = await importProducts(supabase);
    return new Response(JSON.stringify({ ok: true, pecas_encontradas: counts }), {
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
