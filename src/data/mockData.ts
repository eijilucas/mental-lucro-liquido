// Dados mockados para as telas antes de existir um Supabase real conectado.
// O formato espelha as views do schema (supabase/migrations/0001_schema.sql)
// para trocar por dados reais depois só significar apagar este arquivo.

export interface SaleMargin {
  saleId: string;
  productSku: string;
  productName: string;
  quantity: number;
  grossAmount: number;
  directCost: number;
  saleCost: number;
  marketingCost: number;
  fixedCost: number;
  netProfit: number;
}

export const recentSales: SaleMargin[] = [
  {
    saleId: "s1",
    productSku: "CCP-MOL-BLK-M",
    productName: "Calça Cargo Premium Moletom",
    quantity: 1,
    grossAmount: 259.99,
    directCost: 80.0,
    saleCost: 40.3,
    marketingCost: 40.0,
    fixedCost: 0,
    netProfit: 99.69,
  },
  {
    saleId: "s2",
    productSku: "MOL-OVS-GRF-G",
    productName: "Moletom Oversized Grafite",
    quantity: 1,
    grossAmount: 219.9,
    directCost: 92.0,
    saleCost: 34.08,
    marketingCost: 33.8,
    fixedCost: 0,
    netProfit: 60.02,
  },
  {
    saleId: "s3",
    productSku: "CAM-BAS-OFF-P",
    productName: "Camiseta Basic Off-White",
    quantity: 1,
    grossAmount: 89.9,
    directCost: 28.5,
    saleCost: 13.93,
    marketingCost: 13.8,
    fixedCost: 0,
    netProfit: 33.67,
  },
  {
    saleId: "s4",
    productSku: "JAQ-RIP-BLK-M",
    productName: "Jaqueta Corta-Vento Ripstop",
    quantity: 1,
    grossAmount: 349.9,
    directCost: 168.0,
    saleCost: 54.23,
    marketingCost: 53.8,
    fixedCost: 0,
    netProfit: 73.87,
  },
  {
    saleId: "s5",
    productSku: "BON-LOG-BLK-U",
    productName: "Boné Bordado Logo",
    quantity: 1,
    grossAmount: 99.9,
    directCost: 31.0,
    saleCost: 15.48,
    marketingCost: 15.35,
    fixedCost: 0,
    netProfit: 38.07,
  },
];

export const monthlyDre = {
  month: "Agosto 2026",
  grossRevenue: 32240,
  directCost: 9920,
  saleCost: 5001,
  marketingCost: 2232,
  fixedCost: 2728,
  netProfit: 12359,
  salesSynced: 124,
};

export const skuMargin = [
  { sku: "Camiseta Basic Off-White", units: 41, marginPct: 37.5 },
  { sku: "Boné Bordado Logo", units: 28, marginPct: 38.1 },
  { sku: "Calça Cargo Premium Moletom", units: 19, marginPct: 38.3 },
  { sku: "Moletom Oversized Grafite", units: 22, marginPct: 27.3 },
  { sku: "Jaqueta Corta-Vento Ripstop", units: 14, marginPct: 21.1 },
];

export interface OverheadRow {
  id: string;
  category: string;
  amount: number;
  isMarketing: boolean;
  allocationMethod: "per_unit" | "per_revenue";
}

export const monthlyOverhead: OverheadRow[] = [
  { id: "o1", category: "Tráfego pago", amount: 1480.0, isMarketing: true, allocationMethod: "per_revenue" },
  { id: "o2", category: "Influenciadores", amount: 752.0, isMarketing: true, allocationMethod: "per_revenue" },
  { id: "o3", category: "Folha — Felipe, Theo, Renan", amount: 2100.0, isMarketing: false, allocationMethod: "per_unit" },
  { id: "o4", category: "Plataforma / domínio", amount: 318.0, isMarketing: false, allocationMethod: "per_unit" },
  { id: "o5", category: "Contabilidade", amount: 210.0, isMarketing: false, allocationMethod: "per_unit" },
  { id: "o6", category: "Internet, celular, energia", amount: 100.0, isMarketing: false, allocationMethod: "per_unit" },
];

export const feeRates = {
  taxaShopifyPct: 2.9,
  taxaGatewayPct: 3.49,
  impostoPct: 6.0,
  comissaoInfluencerPct: 5.0,
};

export interface ProductCost {
  sku: string;
  productName: string;
  tecido: number;
  estampa: number;
  costura: number;
  sacolinha: number;
  adesivo: number;
  outros: number;
}

export const productCosts: ProductCost[] = [
  { sku: "CCP-MOL-BLK-M", productName: "Calça Cargo Premium Moletom", tecido: 52, estampa: 14, costura: 9, sacolinha: 1.5, adesivo: 1, outros: 2.5 },
  { sku: "MOL-OVS-GRF-G", productName: "Moletom Oversized Grafite", tecido: 61, estampa: 16, costura: 10.5, sacolinha: 1.5, adesivo: 1, outros: 2 },
  { sku: "CAM-BAS-OFF-P", productName: "Camiseta Basic Off-White", tecido: 18, estampa: 6.5, costura: 2.5, sacolinha: 0.8, adesivo: 0.2, outros: 0.5 },
];

export const changeLog = [
  { who: "Vitor mudou Tráfego pago de R$ 1.200 para R$ 1.480", when: "09 ago, 18:42" },
  { who: 'Vitor mudou o jeito de dividir Influenciadores para "proporcional à venda"', when: "03 ago, 11:05" },
  { who: "Vitor cadastrou o custo da peça Jaqueta Corta-Vento Ripstop", when: "01 ago, 09:20" },
];
