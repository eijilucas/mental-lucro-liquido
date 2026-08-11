import { supabase } from "./supabase";

export interface SaleMarginRow {
  sale_id: string;
  product_sku: string;
  product_name: string;
  quantity: number;
  gross_amount: number;
  direct_cost: number;
  sale_cost: number;
  marketing_cost: number;
  fixed_cost: number;
  net_profit: number;
  sale_date: string;
}

export interface MonthlyDreRow {
  month: string;
  gross_revenue: number;
  direct_cost: number;
  sale_cost: number;
  marketing_cost: number;
  fixed_cost: number;
  net_profit: number;
}

export interface OverheadRow {
  id: string;
  month: string;
  category: string;
  amount: number;
  is_marketing: boolean;
  allocation_method: "per_unit" | "per_revenue";
}

export interface FeeRatesRow {
  id: number;
  taxa_shopify_pct: number;
  taxa_gateway_pct: number;
  imposto_pct: number;
  comissao_influencer_pct: number;
  desconto_medio_pct: number;
}

export interface ProductCostRow {
  sku: string;
  product_name: string;
  tecido: number;
  estampa: number;
  costura: number;
  sacolinha: number;
  adesivo: number;
  outros_acabamentos: number;
}

export function currentMonthStart(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function previousMonthStart(): string {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}-01`;
}

function db() {
  if (!supabase) throw new Error("Supabase não configurado");
  return supabase;
}

export async function fetchMonthlyDre(month = currentMonthStart()) {
  const { data, error } = await db().from("monthly_dre").select("*").eq("month", month).maybeSingle<MonthlyDreRow>();
  if (error) throw error;
  return data;
}

export async function fetchPreviousMonthDre() {
  return fetchMonthlyDre(previousMonthStart());
}

export async function fetchRecentSales(limit = 5) {
  const { data, error } = await db()
    .from("sale_margin")
    .select("*")
    .order("sale_date", { ascending: false })
    .limit(limit)
    .returns<SaleMarginRow[]>();
  if (error) throw error;
  return data ?? [];
}

export async function fetchSkuMarginForMonth(month = currentMonthStart()) {
  const start = month;
  const [y, m] = month.split("-").map(Number);
  const nextMonth = new Date(y, m, 1);
  const end = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}-01`;

  const { data, error } = await db()
    .from("sale_margin")
    .select("*")
    .gte("sale_date", start)
    .lt("sale_date", end)
    .returns<SaleMarginRow[]>();
  if (error) throw error;

  const bySku = new Map<string, { sku: string; units: number; grossAmount: number; netProfit: number }>();
  for (const row of data ?? []) {
    const entry = bySku.get(row.product_name) ?? { sku: row.product_name, units: 0, grossAmount: 0, netProfit: 0 };
    entry.units += row.quantity;
    entry.grossAmount += row.gross_amount;
    entry.netProfit += row.net_profit;
    bySku.set(row.product_name, entry);
  }
  return Array.from(bySku.values())
    .map((r) => ({ sku: r.sku, units: r.units, marginPct: r.grossAmount > 0 ? (r.netProfit / r.grossAmount) * 100 : 0 }))
    .sort((a, b) => b.marginPct - a.marginPct);
}

export async function fetchLastSyncTime() {
  const { data, error } = await db()
    .from("sale_revenue")
    .select("synced_at")
    .order("synced_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ synced_at: string }>();
  if (error) throw error;
  return data?.synced_at ?? null;
}

export async function fetchMonthlyOverhead(month = currentMonthStart()) {
  const { data, error } = await db()
    .from("monthly_overhead")
    .select("id, month, category, amount, is_marketing, allocation_method")
    .eq("month", month)
    .order("is_marketing", { ascending: false })
    .returns<OverheadRow[]>();
  if (error) throw error;
  return data ?? [];
}

export async function updateOverheadAmount(id: string, amount: number) {
  const { error } = await db().from("monthly_overhead").update({ amount, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}

export async function updateOverheadMethod(id: string, allocation_method: OverheadRow["allocation_method"]) {
  const { error } = await db().from("monthly_overhead").update({ allocation_method, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}

export async function deleteOverhead(id: string) {
  const { error } = await db().from("monthly_overhead").delete().eq("id", id);
  if (error) throw error;
}

export async function insertOverhead(row: {
  category: string;
  amount: number;
  is_marketing: boolean;
  allocation_method: OverheadRow["allocation_method"];
  month?: string;
}) {
  const { data, error } = await db()
    .from("monthly_overhead")
    .insert({ ...row, month: row.month ?? currentMonthStart() })
    .select("id, month, category, amount, is_marketing, allocation_method")
    .single<OverheadRow>();
  if (error) throw error;
  return data;
}

export async function fetchFeeRates() {
  const { data, error } = await db().from("sale_fee_rates").select("*").eq("id", 1).single<FeeRatesRow>();
  if (error) throw error;
  return data;
}

export async function updateFeeRates(rates: Omit<FeeRatesRow, "id">) {
  const { error } = await db().from("sale_fee_rates").update({ ...rates, updated_at: new Date().toISOString() }).eq("id", 1);
  if (error) throw error;
}

export async function fetchProductCosts() {
  const { data, error } = await db()
    .from("product_costs")
    .select("sku, product_name, tecido, estampa, costura, sacolinha, adesivo, outros_acabamentos")
    .order("product_name")
    .returns<ProductCostRow[]>();
  if (error) throw error;
  return data ?? [];
}

export async function updateProductCost(sku: string, field: keyof Omit<ProductCostRow, "sku" | "product_name">, value: number) {
  const { error } = await db()
    .from("product_costs")
    .update({ [field]: value, updated_at: new Date().toISOString() })
    .eq("sku", sku);
  if (error) throw error;
}

export async function insertProductCost(row: ProductCostRow) {
  const { data, error } = await db().from("product_costs").insert(row).select().single<ProductCostRow>();
  if (error) throw error;
  return data;
}
