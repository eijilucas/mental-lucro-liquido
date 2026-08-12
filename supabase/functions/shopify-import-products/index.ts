// Importa o catálogo de produtos da Shopify pra `product_costs`, criando
// as linhas que ainda não existem (SKU + nome, custo zerado — mesma
// lógica de "stub" que o shopify-webhook já usa quando uma venda chega
// com SKU novo). Rodar isso ANTES do webhook começar a receber vendas
// deixa o admin com o catálogo inteiro pronto pra preencher custo, em
// vez de ir descobrindo peça por peça conforme elas vendem.
//
// Não é um webhook — é disparada manualmente (uma vez, ou de vez em
// quando pra pegar produto novo), com um POST protegido por secret
// próprio (não usa o SHOPIFY_WEBHOOK_SECRET, porque isso aqui não vem
// da Shopify, é você chamando a função).
//
// Configuração necessária:
//   npx supabase secrets set SHOPIFY_STORE_DOMAIN=sua-loja.myshopify.com --project-ref <ref>
//   npx supabase secrets set SHOPIFY_ADMIN_API_TOKEN=<token do app custom, escopo read_products> --project-ref <ref>
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
const SHOPIFY_ADMIN_API_TOKEN = Deno.env.get("SHOPIFY_ADMIN_API_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Versão da API REST da Shopify — confira em shopify.dev se ainda é
// suportada na hora de configurar; elas saem trimestralmente.
const SHOPIFY_API_VERSION = "2025-01";

interface ShopifyVariant {
  sku: string | null;
}

interface ShopifyProduct {
  title: string;
  variants: ShopifyVariant[];
}

interface ProductCostStub {
  sku: string;
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

async function fetchAllProducts(): Promise<ShopifyProduct[]> {
  const products: ShopifyProduct[] = [];
  let url: string | null =
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=250`;

  while (url) {
    const res = await fetch(url, {
      headers: { "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_TOKEN },
    });
    if (!res.ok) {
      throw new Error(`Shopify respondeu ${res.status} ao listar produtos`);
    }
    const data = await res.json();
    products.push(...(data.products ?? []));
    url = extractNextUrl(res.headers.get("Link"));
  }

  return products;
}

async function importProducts(supabase: SupabaseClient): Promise<number> {
  const products = await fetchAllProducts();

  const stubs: ProductCostStub[] = [];
  const seen = new Set<string>();
  for (const product of products) {
    for (const variant of product.variants ?? []) {
      if (!variant.sku || seen.has(variant.sku)) continue;
      seen.add(variant.sku);
      stubs.push({
        sku: variant.sku,
        product_name: product.title,
        tecido: 0,
        estampa: 0,
        costura: 0,
        sacolinha: 0,
        adesivo: 0,
        outros_acabamentos: 0,
      });
    }
  }

  if (stubs.length === 0) return 0;

  const { error } = await supabase
    .from("product_costs")
    .upsert(stubs, { onConflict: "sku", ignoreDuplicates: true });
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

  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_API_TOKEN) {
    return new Response("SHOPIFY_STORE_DOMAIN ou SHOPIFY_ADMIN_API_TOKEN não configurados", { status: 500 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const count = await importProducts(supabase);
    return new Response(JSON.stringify({ ok: true, skus_encontrados: count }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
