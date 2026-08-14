import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { TopBar, AdminBackLink } from "../components/TopBar";
import { SignOutButton } from "../components/RequireAuth";
import { DateRangePicker } from "../components/DateRangePicker";
import { DreWaterfall, aggregateDre } from "../components/DreWaterfall";
import { supabase } from "../lib/supabase";
import {
  fetchMonthlyOverhead,
  updateOverheadAmount,
  updateOverheadMethod,
  deleteOverhead,
  insertOverhead,
  fetchFeeRates,
  updateFeeRates,
  fetchProductCosts,
  updateProductCost,
  updateProductName,
  deleteProductCost,
  insertProductCost,
  fetchSkuMarginForRange,
  fetchSaleMarginForRange,
  currentMonthStart,
  todayStr,
  type OverheadRow,
  type FeeRatesRow,
  type ProductCostRow,
  type SaleMarginRow,
} from "../lib/queries";

type Tab = "sku" | "fees" | "overhead" | "profit" | "coupon";
type PieceMargin = { sku: string; units: number; marginPct: number };

function marginClass(pct: number) {
  if (pct >= 40) return "good";
  if (pct >= 15) return "mid";
  return "low";
}

function money(v: number) {
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function parseMoney(value: string): number | null {
  const parsed = Number(value.replace(/\./g, "").replace(",", "."));
  return Number.isNaN(parsed) ? null : parsed;
}
// Campos de percentual usam toFixed(2), que gera "6.00" (ponto decimal,
// sem separador de milhar) — parseMoney interpretaria o ponto como
// separador de milhar e leria "600". Percentual nunca precisa de
// separador de milhar, então essa função só troca vírgula por ponto.
function parsePercent(value: string): number | null {
  const parsed = Number(value.replace("%", "").trim().replace(",", "."));
  return Number.isNaN(parsed) ? null : parsed;
}
function monthLabel(monthStr: string) {
  const [y, m] = monthStr.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("pt-BR", { month: "short", year: "numeric" });
}
function dateLabelShort(dateStr: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}
function rangeLabel(start: string, end: string) {
  return start === end ? dateLabelShort(start) : `${dateLabelShort(start)} a ${dateLabelShort(end)}`;
}
function shiftMonth(monthStr: string, delta: number) {
  const [y, m] = monthStr.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function emptyProductCost(product_line: ProductCostRow["product_line"], collection: string | null = null): Omit<ProductCostRow, "id"> {
  return {
    sku: null,
    product_name: "",
    tecido: 0,
    estampa: 0,
    costura: 0,
    outros_acabamentos: 0,
    product_line,
    collection,
    collection_published_at: null,
  };
}

function ProductLinePanel({
  title,
  products,
  newProduct,
  setNewProduct,
  onCostBlur,
  onNameBlur,
  onDelete,
  onAdd,
  showAddRow = true,
}: {
  title: string;
  products: ProductCostRow[];
  newProduct: Omit<ProductCostRow, "id">;
  setNewProduct: Dispatch<SetStateAction<Omit<ProductCostRow, "id">>>;
  onCostBlur: (id: string, field: keyof Omit<ProductCostRow, "id" | "sku" | "product_name" | "product_line">, value: string) => void;
  onNameBlur: (id: string, value: string) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
  showAddRow?: boolean;
}) {
  const costFields = ["tecido", "estampa", "costura", "outros_acabamentos"] as const;
  const newTotal = costFields.reduce((sum, f) => sum + newProduct[f], 0);

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">{title}</div>
          <div className="panel-hint">
            A soma das colunas é o quanto custa produzir a peça — é isso que sai da venda antes de qualquer outra coisa.
            Sacolinha e adesivo custam o mesmo pra toda peça, então ficaram na aba "Taxas de venda".
          </div>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Peça</th>
              <th className="num">Tecido</th>
              <th className="num">Estampa</th>
              <th className="num">Costura</th>
              <th className="num">Outros</th>
              <th className="num">Total</th>
              <th style={{ width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => {
              const total = p.tecido + p.estampa + p.costura + p.outros_acabamentos;
              return (
                <tr key={p.id}>
                  <td className="sku">
                    <input
                      className="cell-text"
                      defaultValue={p.product_name}
                      onBlur={(e) => onNameBlur(p.id, e.target.value)}
                      style={{ width: 220, display: "block" }}
                    />
                    {total === 0 && (
                      <span className="margin-pill low" style={{ marginTop: 6 }} title="Peça criada automaticamente pela primeira venda — falta preencher o custo">
                        custo zerado
                      </span>
                    )}
                  </td>
                  {costFields.map((field) => (
                    <td className="num" key={field}>
                      <input className="cell-input" defaultValue={money(p[field])} onBlur={(e) => onCostBlur(p.id, field, e.target.value)} />
                    </td>
                  ))}
                  <td className="num total-cell">{money(total)}</td>
                  <td>
                    <div className="icon-cell" onClick={() => onDelete(p.id)}>✕</div>
                  </td>
                </tr>
              );
            })}
            {showAddRow && (
              <tr>
                <td className="sku">
                  <input
                    className="cell-text"
                    placeholder="Nome da peça"
                    style={{ width: 220 }}
                    value={newProduct.product_name}
                    onChange={(e) => setNewProduct((s) => ({ ...s, product_name: e.target.value }))}
                  />
                </td>
                {costFields.map((field) => (
                  <td className="num" key={field}>
                    <input
                      className="cell-input"
                      value={money(newProduct[field])}
                      onChange={(e) => {
                        const v = parseMoney(e.target.value);
                        if (v !== null) setNewProduct((s) => ({ ...s, [field]: v }));
                      }}
                    />
                  </td>
                ))}
                <td className="num total-cell">{money(newTotal)}</td>
                <td>
                  <div className="icon-cell" onClick={onAdd}>+</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Admin() {
  const [tab, setTab] = useState<Tab>("overhead");
  const [overhead, setOverhead] = useState<OverheadRow[]>([]);
  const [feeRates, setFeeRates] = useState<FeeRatesRow | null>(null);
  const [productCosts, setProductCosts] = useState<ProductCostRow[]>([]);
  const [pieceMargin, setPieceMargin] = useState<PieceMargin[]>([]);
  const [pieceSearch, setPieceSearch] = useState("");
  const [pieceSort, setPieceSort] = useState<{ field: keyof PieceMargin; dir: "asc" | "desc" }>({ field: "marginPct", dir: "desc" });
  const [profitRangeStart, setProfitRangeStart] = useState(currentMonthStart());
  const [profitRangeEnd, setProfitRangeEnd] = useState(todayStr());
  const [couponRows, setCouponRows] = useState<SaleMarginRow[]>([]);
  const [overheadMonth, setOverheadMonth] = useState(currentMonthStart());
  const [newMarketing, setNewMarketing] = useState({ category: "", amount: "0,00", method: "per_revenue" as OverheadRow["allocation_method"] });
  const [newFixed, setNewFixed] = useState({ category: "", amount: "0,00", method: "per_unit" as OverheadRow["allocation_method"] });
  const [newProductBasico, setNewProductBasico] = useState<Omit<ProductCostRow, "id">>(() => emptyProductCost("basico"));
  const [newProductExclusivo, setNewProductExclusivo] = useState<Omit<ProductCostRow, "id">>(() => emptyProductCost("exclusivo"));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [feeSaved, setFeeSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [rates, costs] = await Promise.all([fetchFeeRates(), fetchProductCosts()]);
        if (cancelled) return;
        setFeeRates(rates);
        setProductCosts(costs);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Erro ao carregar dados.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchMonthlyOverhead(overheadMonth).then((rows) => {
      if (!cancelled) setOverhead(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [overheadMonth]);

  useEffect(() => {
    let cancelled = false;
    fetchSkuMarginForRange(profitRangeStart, profitRangeEnd).then((rows) => {
      if (!cancelled) setPieceMargin(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [profitRangeStart, profitRangeEnd]);

  useEffect(() => {
    let cancelled = false;
    fetchSaleMarginForRange(profitRangeStart, profitRangeEnd).then((rows) => {
      if (!cancelled) setCouponRows(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [profitRangeStart, profitRangeEnd]);

  async function handleAmountBlur(id: string, value: string) {
    const parsed = parseMoney(value);
    if (parsed === null) return;
    setOverhead((rows) => rows.map((r) => (r.id === id ? { ...r, amount: parsed } : r)));
    await updateOverheadAmount(id, parsed);
  }

  async function handleMethodChange(id: string, method: OverheadRow["allocation_method"]) {
    setOverhead((rows) => rows.map((r) => (r.id === id ? { ...r, allocation_method: method } : r)));
    await updateOverheadMethod(id, method);
  }

  async function handleDeleteOverhead(id: string) {
    setOverhead((rows) => rows.filter((r) => r.id !== id));
    await deleteOverhead(id);
  }

  async function handleAddMarketing() {
    const amount = parseMoney(newMarketing.amount) ?? 0;
    if (!newMarketing.category.trim()) return;
    const row = await insertOverhead({ category: newMarketing.category.trim(), amount, is_marketing: true, allocation_method: newMarketing.method, month: overheadMonth });
    setOverhead((rows) => [...rows, row]);
    setNewMarketing({ category: "", amount: "0,00", method: "per_revenue" });
  }

  async function handleAddFixed() {
    const amount = parseMoney(newFixed.amount) ?? 0;
    if (!newFixed.category.trim()) return;
    const row = await insertOverhead({ category: newFixed.category.trim(), amount, is_marketing: false, allocation_method: newFixed.method, month: overheadMonth });
    setOverhead((rows) => [...rows, row]);
    setNewFixed({ category: "", amount: "0,00", method: "per_unit" });
  }

  async function handleFeeRatesSave() {
    if (!feeRates) return;
    await updateFeeRates({
      taxa_shopify_pct: feeRates.taxa_shopify_pct,
      taxa_gateway_pct: feeRates.taxa_gateway_pct,
      imposto_pct: feeRates.imposto_pct,
      comissao_influencer_pct: feeRates.comissao_influencer_pct,
      desconto_medio_pct: feeRates.desconto_medio_pct,
      sacolinha: feeRates.sacolinha,
      adesivo: feeRates.adesivo,
    });
    setFeeSaved(true);
    setTimeout(() => setFeeSaved(false), 2500);
  }

  async function handleProductCostBlur(id: string, field: keyof Omit<ProductCostRow, "id" | "sku" | "product_name" | "product_line">, value: string) {
    const parsed = parseMoney(value);
    if (parsed === null) return;
    setProductCosts((rows) => rows.map((r) => (r.id === id ? { ...r, [field]: parsed } : r)));
    await updateProductCost(id, field, parsed);
  }

  async function handleAddProduct(draft: Omit<ProductCostRow, "id">, reset: () => void) {
    if (!draft.product_name.trim()) return;
    const row = await insertProductCost(draft);
    setProductCosts((rows) => [...rows, row]);
    reset();
  }

  async function handleProductNameBlur(id: string, value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    setProductCosts((rows) => rows.map((r) => (r.id === id ? { ...r, product_name: trimmed } : r)));
    await updateProductName(id, trimmed);
  }

  async function handleDeleteProduct(id: string) {
    setProductCosts((rows) => rows.filter((r) => r.id !== id));
    await deleteProductCost(id);
  }

  function handlePieceSort(field: keyof PieceMargin) {
    setPieceSort((s) => (s.field === field ? { field, dir: s.dir === "asc" ? "desc" : "asc" } : { field, dir: field === "sku" ? "asc" : "desc" }));
  }

  const marketingPool = overhead.filter((r) => r.is_marketing).reduce((sum, r) => sum + r.amount, 0);
  const fixedPool = overhead.filter((r) => !r.is_marketing).reduce((sum, r) => sum + r.amount, 0);

  // Só mostra o painel da coleção MAIS RECENTE (o drop atual — identificado
  // pelo published_at mais novo, sem precisar hardcodar o nome). Drops
  // antigos e peças sem coleção ficam escondidos, mas continuam no banco —
  // só não poluem mais a tela.
  const exclusivoAll = productCosts.filter((p) => p.product_line === "exclusivo");
  const currentCollection = exclusivoAll
    .filter((p) => p.collection && p.collection_published_at)
    .reduce<{ collection: string; publishedAt: string } | null>((latest, p) => {
      if (!latest || p.collection_published_at! > latest.publishedAt) {
        return { collection: p.collection!, publishedAt: p.collection_published_at! };
      }
      return latest;
    }, null);

  const exclusivoGroups: [string | null, ProductCostRow[]][] = currentCollection
    ? [[currentCollection.collection, exclusivoAll.filter((p) => p.collection === currentCollection.collection)]]
    : [[null, exclusivoAll.filter((p) => p.collection === null)]];

  if (!supabase) {
    return (
      <div className="app">
        <p className="page-sub">Supabase não configurado — faltam as variáveis de ambiente (.env).</p>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar subtitle="jackpot · admin">
        <div className="topbar-controls">
          <AdminBackLink />
          <SignOutButton />
        </div>
      </TopBar>

      <h1 className="page-title">Custos e taxas</h1>

      {error && <p className="page-sub" style={{ color: "var(--negative)" }}>{error}</p>}
      {loading && <p className="page-sub">Carregando...</p>}

      {!loading && (
        <>
          <div className="tabs">
            <div className={`tab ${tab === "sku" ? "active" : ""}`} onClick={() => setTab("sku")}>
              Custo de cada peça
              <span className="count">
                {productCosts.filter((p) => p.product_line === "basico").length +
                  exclusivoGroups.reduce((sum, [, products]) => sum + products.length, 0)}
              </span>
            </div>
            <div className={`tab ${tab === "fees" ? "active" : ""}`} onClick={() => setTab("fees")}>
              Taxas de venda
            </div>
            <div className={`tab ${tab === "overhead" ? "active" : ""}`} onClick={() => setTab("overhead")}>
              Gastos do mês
              <span className="count">{monthLabel(overheadMonth)}</span>
            </div>
            <div className={`tab ${tab === "profit" ? "active" : ""}`} onClick={() => setTab("profit")}>
              Lucro por peça
              <span className="count">{rangeLabel(profitRangeStart, profitRangeEnd)}</span>
            </div>
            <div className={`tab ${tab === "coupon" ? "active" : ""}`} onClick={() => setTab("coupon")}>
              Cupom
              <span className="count">{rangeLabel(profitRangeStart, profitRangeEnd)}</span>
            </div>
          </div>

          {tab === "overhead" && (
            <>
              <div className="allocation-summary">
                <div className="as-cell">
                  <div className="as-label">Gasto com marketing</div>
                  <div className="as-value accent">R$ {money(marketingPool)}</div>
                </div>
                <div className="as-cell">
                  <div className="as-label">Gasto fixo</div>
                  <div className="as-value">R$ {money(fixedPool)}</div>
                </div>
                <div className="as-cell">
                  <div className="as-label">Mês</div>
                  <div className="as-value" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <button
                      type="button"
                      className="icon-btn"
                      style={{ width: 22, height: 22, fontSize: 12 }}
                      onClick={() => setOverheadMonth((m) => shiftMonth(m, -1))}
                    >
                      ‹
                    </button>
                    {monthLabel(overheadMonth)}
                    <button
                      type="button"
                      className="icon-btn"
                      style={{ width: 22, height: 22, fontSize: 12 }}
                      onClick={() => setOverheadMonth((m) => shiftMonth(m, 1))}
                      disabled={overheadMonth >= currentMonthStart()}
                    >
                      ›
                    </button>
                  </div>
                </div>
              </div>

              <div className="panel">
                <div className="panel-head">
                  <div>
                    <div className="panel-title">Marketing</div>
                    <div className="panel-hint">
                      Cada gasto pode ser fixo (mesmo valor pra toda peça vendida) ou variável (proporcional ao valor de cada venda).
                    </div>
                  </div>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Nome do gasto</th>
                        <th className="num" style={{ width: 120 }}>Valor</th>
                        <th style={{ width: 170 }}>Como dividir</th>
                        <th style={{ width: 40 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {overhead.filter((row) => row.is_marketing).map((row) => (
                        <tr key={row.id}>
                          <td>{row.category}</td>
                          <td className="num">
                            <input className="cell-input" defaultValue={money(row.amount)} onBlur={(e) => handleAmountBlur(row.id, e.target.value)} />
                          </td>
                          <td>
                            <div className="method-toggle">
                              <button
                                type="button"
                                title="Mesmo valor pra toda peça vendida no mês, dividido igualmente"
                                className={row.allocation_method === "per_unit" ? "active" : ""}
                                onClick={() => handleMethodChange(row.id, "per_unit")}
                              >
                                Fixo
                              </button>
                              <button
                                type="button"
                                title="Valor proporcional ao preço de cada venda — quem vendeu mais caro absorve mais"
                                className={row.allocation_method === "per_revenue" ? "active" : ""}
                                onClick={() => handleMethodChange(row.id, "per_revenue")}
                              >
                                Variável
                              </button>
                            </div>
                          </td>
                          <td>
                            <div className="icon-cell" onClick={() => handleDeleteOverhead(row.id)}>✕</div>
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td>
                          <input
                            className="cell-text"
                            placeholder="Nome do novo gasto de marketing..."
                            style={{ width: 220 }}
                            value={newMarketing.category}
                            onChange={(e) => setNewMarketing((s) => ({ ...s, category: e.target.value }))}
                          />
                        </td>
                        <td className="num">
                          <input
                            className="cell-input"
                            value={newMarketing.amount}
                            onChange={(e) => setNewMarketing((s) => ({ ...s, amount: e.target.value }))}
                          />
                        </td>
                        <td>
                          <div className="method-toggle">
                            <button
                              type="button"
                              title="Mesmo valor pra toda peça vendida no mês, dividido igualmente"
                              className={newMarketing.method === "per_unit" ? "active" : ""}
                              onClick={() => setNewMarketing((s) => ({ ...s, method: "per_unit" }))}
                            >
                              Fixo
                            </button>
                            <button
                              type="button"
                              title="Valor proporcional ao preço de cada venda — quem vendeu mais caro absorve mais"
                              className={newMarketing.method === "per_revenue" ? "active" : ""}
                              onClick={() => setNewMarketing((s) => ({ ...s, method: "per_revenue" }))}
                            >
                              Variável
                            </button>
                          </div>
                        </td>
                        <td>
                          <div className="icon-cell" onClick={handleAddMarketing}>+</div>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="panel">
                <div className="panel-head">
                  <div>
                    <div className="panel-title">Fixos</div>
                    <div className="panel-hint">
                      Custos estruturais do negócio — plataforma, folha, contabilidade — que existem independente de quanto vendeu.
                    </div>
                  </div>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Nome do gasto</th>
                        <th className="num" style={{ width: 120 }}>Valor</th>
                        <th style={{ width: 170 }}>Como dividir</th>
                        <th style={{ width: 40 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {overhead.filter((row) => !row.is_marketing).map((row) => (
                        <tr key={row.id}>
                          <td>{row.category}</td>
                          <td className="num">
                            <input className="cell-input" defaultValue={money(row.amount)} onBlur={(e) => handleAmountBlur(row.id, e.target.value)} />
                          </td>
                          <td>
                            <div className="method-toggle">
                              <button
                                type="button"
                                title="Mesmo valor pra toda peça vendida no mês, dividido igualmente"
                                className={row.allocation_method === "per_unit" ? "active" : ""}
                                onClick={() => handleMethodChange(row.id, "per_unit")}
                              >
                                Fixo
                              </button>
                              <button
                                type="button"
                                title="Valor proporcional ao preço de cada venda — quem vendeu mais caro absorve mais"
                                className={row.allocation_method === "per_revenue" ? "active" : ""}
                                onClick={() => handleMethodChange(row.id, "per_revenue")}
                              >
                                Variável
                              </button>
                            </div>
                          </td>
                          <td>
                            <div className="icon-cell" onClick={() => handleDeleteOverhead(row.id)}>✕</div>
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td>
                          <input
                            className="cell-text"
                            placeholder="Nome do novo gasto fixo..."
                            style={{ width: 220 }}
                            value={newFixed.category}
                            onChange={(e) => setNewFixed((s) => ({ ...s, category: e.target.value }))}
                          />
                        </td>
                        <td className="num">
                          <input
                            className="cell-input"
                            value={newFixed.amount}
                            onChange={(e) => setNewFixed((s) => ({ ...s, amount: e.target.value }))}
                          />
                        </td>
                        <td>
                          <div className="method-toggle">
                            <button
                              type="button"
                              title="Mesmo valor pra toda peça vendida no mês, dividido igualmente"
                              className={newFixed.method === "per_unit" ? "active" : ""}
                              onClick={() => setNewFixed((s) => ({ ...s, method: "per_unit" }))}
                            >
                              Fixo
                            </button>
                            <button
                              type="button"
                              title="Valor proporcional ao preço de cada venda — quem vendeu mais caro absorve mais"
                              className={newFixed.method === "per_revenue" ? "active" : ""}
                              onClick={() => setNewFixed((s) => ({ ...s, method: "per_revenue" }))}
                            >
                              Variável
                            </button>
                          </div>
                        </td>
                        <td>
                          <div className="icon-cell" onClick={handleAddFixed}>+</div>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {tab === "fees" && feeRates && (
            <div className="panel">
              <div className="panel-head">
                <div>
                  <div className="panel-title">Taxas de venda — atuais</div>
                  <div className="panel-hint">Aplicadas em cima do valor de cada venda. Mudanças valem a partir da próxima atualização.</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  {feeSaved && <span style={{ color: "var(--positive)", fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase" }}>Salvo</span>}
                  <button className="btn btn-primary" onClick={handleFeeRatesSave}>Salvar</button>
                </div>
              </div>
              <div className="form-grid">
                <div className="field">
                  <label>Taxa Shopify</label>
                  <input
                    defaultValue={`${(feeRates.taxa_shopify_pct * 100).toFixed(2)}%`}
                    onBlur={(e) => {
                      const v = parsePercent(e.target.value);
                      if (v !== null) setFeeRates({ ...feeRates, taxa_shopify_pct: v / 100 });
                    }}
                  />
                </div>
                <div className="field">
                  <label>Taxa do cartão</label>
                  <input
                    defaultValue={`${(feeRates.taxa_gateway_pct * 100).toFixed(2)}%`}
                    onBlur={(e) => {
                      const v = parsePercent(e.target.value);
                      if (v !== null) setFeeRates({ ...feeRates, taxa_gateway_pct: v / 100 });
                    }}
                  />
                </div>
                <div className="field">
                  <label>Imposto (Simples)</label>
                  <input
                    defaultValue={`${(feeRates.imposto_pct * 100).toFixed(2)}%`}
                    onBlur={(e) => {
                      const v = parsePercent(e.target.value);
                      if (v !== null) setFeeRates({ ...feeRates, imposto_pct: v / 100 });
                    }}
                  />
                </div>
                <div className="field">
                  <label>Comissão do influenciador</label>
                  <input
                    defaultValue={`${(feeRates.comissao_influencer_pct * 100).toFixed(2)}%`}
                    onBlur={(e) => {
                      const v = parsePercent(e.target.value);
                      if (v !== null) setFeeRates({ ...feeRates, comissao_influencer_pct: v / 100 });
                    }}
                  />
                  <div className="suffix">mesma taxa do painel de comissão</div>
                </div>
                <div className="field">
                  <label>Sacolinha</label>
                  <input
                    defaultValue={money(feeRates.sacolinha)}
                    onBlur={(e) => {
                      const v = parseMoney(e.target.value);
                      if (v !== null) setFeeRates({ ...feeRates, sacolinha: v });
                    }}
                  />
                  <div className="suffix">custo fixo por peça, igual pra todas</div>
                </div>
                <div className="field">
                  <label>Adesivo</label>
                  <input
                    defaultValue={money(feeRates.adesivo)}
                    onBlur={(e) => {
                      const v = parseMoney(e.target.value);
                      if (v !== null) setFeeRates({ ...feeRates, adesivo: v });
                    }}
                  />
                  <div className="suffix">custo fixo por peça, igual pra todas</div>
                </div>
              </div>
            </div>
          )}

          {tab === "sku" && (
            <>
              <ProductLinePanel
                title="Custo de cada peça — Drop Básico"
                products={productCosts.filter((p) => p.product_line === "basico")}
                newProduct={newProductBasico}
                setNewProduct={setNewProductBasico}
                onCostBlur={handleProductCostBlur}
                onNameBlur={handleProductNameBlur}
                onDelete={handleDeleteProduct}
                onAdd={() => handleAddProduct(newProductBasico, () => setNewProductBasico(emptyProductCost("basico")))}
              />
              {exclusivoGroups.map(([collection, products]) => (
                <ProductLinePanel
                  key={collection ?? "sem-colecao"}
                  title={`Custo de cada peça — Exclusivos — ${collection ?? "Sem coleção"}`}
                  products={products}
                  newProduct={newProductExclusivo}
                  setNewProduct={setNewProductExclusivo}
                  onCostBlur={handleProductCostBlur}
                  onNameBlur={handleProductNameBlur}
                  onDelete={handleDeleteProduct}
                  onAdd={() =>
                    handleAddProduct({ ...newProductExclusivo, collection }, () =>
                      setNewProductExclusivo(emptyProductCost("exclusivo", collection)),
                    )
                  }
                  showAddRow
                />
              ))}
            </>
          )}

          {tab === "profit" && (
            <div className="panel">
              <div className="panel-head">
                <div>
                  <div className="panel-title">Lucro por peça — {rangeLabel(profitRangeStart, profitRangeEnd)}</div>
                  <div className="panel-hint">Peças vendidas no período — clique no cabeçalho pra ordenar.</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <DateRangePicker
                    start={profitRangeStart}
                    end={profitRangeEnd}
                    maxDate={todayStr()}
                    onChange={(s, e) => { setProfitRangeStart(s); setProfitRangeEnd(e); }}
                  />
                  <input
                    className="cell-text"
                    placeholder="Buscar peça..."
                    value={pieceSearch}
                    onChange={(e) => setPieceSearch(e.target.value)}
                    style={{ width: 160 }}
                  />
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th className="sortable" onClick={() => handlePieceSort("sku")}>
                        Peça{pieceSort.field === "sku" ? (pieceSort.dir === "asc" ? " ▲" : " ▼") : ""}
                      </th>
                      <th className="num sortable" onClick={() => handlePieceSort("units")}>
                        Unid.{pieceSort.field === "units" ? (pieceSort.dir === "asc" ? " ▲" : " ▼") : ""}
                      </th>
                      <th className="num sortable" onClick={() => handlePieceSort("marginPct")}>
                        Margem{pieceSort.field === "marginPct" ? (pieceSort.dir === "asc" ? " ▲" : " ▼") : ""}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const filtered = pieceMargin
                        .filter((row) => row.sku.toLowerCase().includes(pieceSearch.trim().toLowerCase()))
                        .sort((a, b) => {
                          const dir = pieceSort.dir === "asc" ? 1 : -1;
                          const field = pieceSort.field;
                          if (field === "sku") return a.sku.localeCompare(b.sku) * dir;
                          return (a[field] - b[field]) * dir;
                        });
                      if (filtered.length === 0) {
                        return (
                          <tr>
                            <td colSpan={3} style={{ color: "var(--ink-faint)" }}>
                              {pieceMargin.length === 0 ? "Nenhuma venda ainda esse mês." : "Nenhuma peça encontrada."}
                            </td>
                          </tr>
                        );
                      }
                      return filtered.map((row) => (
                        <tr key={row.sku}>
                          <td className="sku">{row.sku}</td>
                          <td className="num">{row.units}</td>
                          <td className="num">
                            <span className={`margin-pill ${marginClass(row.marginPct)}`}>{row.marginPct.toFixed(1)}%</span>
                          </td>
                        </tr>
                      ));
                    })()}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === "coupon" && (
            <>
              <div className="panel-head" style={{ padding: "0 0 16px" }}>
                <div>
                  <div className="panel-title" style={{ marginBottom: 0 }}>Cupom — {rangeLabel(profitRangeStart, profitRangeEnd)}</div>
                  <div className="panel-hint">DRE separado por pedido ter usado cupom de desconto ou não.</div>
                </div>
                <DateRangePicker
                  start={profitRangeStart}
                  end={profitRangeEnd}
                  maxDate={todayStr()}
                  onChange={(s, e) => { setProfitRangeStart(s); setProfitRangeEnd(e); }}
                />
              </div>
              <DreWaterfall
                title="DRE — Com cupom"
                hint="pedidos com código de desconto aplicado"
                dre={aggregateDre(couponRows.filter((r) => r.has_coupon))}
              />
              <DreWaterfall
                title="DRE — Sem cupom"
                hint="pedidos sem código de desconto"
                dre={aggregateDre(couponRows.filter((r) => !r.has_coupon))}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
