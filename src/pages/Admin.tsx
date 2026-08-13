import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { TopBar, AdminBackLink } from "../components/TopBar";
import { SignOutButton } from "../components/RequireAuth";
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
  updateProductLine,
  deleteProductCost,
  insertProductCost,
  fetchSkuMarginForMonth,
  currentMonthStart,
  type OverheadRow,
  type FeeRatesRow,
  type ProductCostRow,
} from "../lib/queries";

type Tab = "sku" | "fees" | "overhead" | "profit";
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

function emptyProductCost(product_line: ProductCostRow["product_line"], collection: string | null = null): Omit<ProductCostRow, "id"> {
  return {
    sku: null,
    product_name: "",
    tecido: 0,
    estampa: 0,
    costura: 0,
    sacolinha: 0,
    adesivo: 0,
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
  onMove,
  onDelete,
  onAdd,
  moveLabel,
  showAddRow = true,
}: {
  title: string;
  products: ProductCostRow[];
  newProduct: Omit<ProductCostRow, "id">;
  setNewProduct: Dispatch<SetStateAction<Omit<ProductCostRow, "id">>>;
  onCostBlur: (id: string, field: keyof Omit<ProductCostRow, "id" | "sku" | "product_name" | "product_line">, value: string) => void;
  onNameBlur: (id: string, value: string) => void;
  onMove: (id: string) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
  moveLabel: string;
  showAddRow?: boolean;
}) {
  const costFields = ["tecido", "estampa", "costura", "sacolinha", "adesivo", "outros_acabamentos"] as const;
  const newTotal = costFields.reduce((sum, f) => sum + newProduct[f], 0);

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">{title}</div>
          <div className="panel-hint">A soma das colunas é o quanto custa produzir a peça — é isso que sai da venda antes de qualquer outra coisa.</div>
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
              <th className="num">Sacolinha</th>
              <th className="num">Adesivo</th>
              <th className="num">Outros</th>
              <th className="num">Total</th>
              <th style={{ width: 70 }}></th>
              <th style={{ width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => {
              const total = p.tecido + p.estampa + p.costura + p.sacolinha + p.adesivo + p.outros_acabamentos;
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
                    <button type="button" className="btn btn-ghost" style={{ padding: "5px 8px", fontSize: 10 }} onClick={() => onMove(p.id)}>
                      {moveLabel}
                    </button>
                  </td>
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
                    placeholder="nome da peça"
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
                <td></td>
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
        const [overheadRows, rates, costs, margin] = await Promise.all([
          fetchMonthlyOverhead(),
          fetchFeeRates(),
          fetchProductCosts(),
          fetchSkuMarginForMonth(),
        ]);
        if (cancelled) return;
        setOverhead(overheadRows);
        setFeeRates(rates);
        setProductCosts(costs);
        setPieceMargin(margin);
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
    const row = await insertOverhead({ category: newMarketing.category.trim(), amount, is_marketing: true, allocation_method: newMarketing.method });
    setOverhead((rows) => [...rows, row]);
    setNewMarketing({ category: "", amount: "0,00", method: "per_revenue" });
  }

  async function handleAddFixed() {
    const amount = parseMoney(newFixed.amount) ?? 0;
    if (!newFixed.category.trim()) return;
    const row = await insertOverhead({ category: newFixed.category.trim(), amount, is_marketing: false, allocation_method: newFixed.method });
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

  async function handleLineChange(id: string, line: ProductCostRow["product_line"]) {
    setProductCosts((rows) => rows.map((r) => (r.id === id ? { ...r, product_line: line } : r)));
    await updateProductLine(id, line);
  }

  async function handleDeleteProduct(id: string) {
    setProductCosts((rows) => rows.filter((r) => r.id !== id));
    await deleteProductCost(id);
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
      <TopBar subtitle="lucro líquido · admin">
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
              <span className="count">{monthLabel(currentMonthStart())}</span>
            </div>
            <div className={`tab ${tab === "profit" ? "active" : ""}`} onClick={() => setTab("profit")}>
              Lucro por peça
              <span className="count">{monthLabel(currentMonthStart())}</span>
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
                  <div className="as-value">{monthLabel(currentMonthStart())}</div>
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
                            placeholder="nome do novo gasto de marketing..."
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
                            placeholder="nome do novo gasto fixo..."
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
                onMove={(id) => handleLineChange(id, "exclusivo")}
                onDelete={handleDeleteProduct}
                onAdd={() => handleAddProduct(newProductBasico, () => setNewProductBasico(emptyProductCost("basico")))}
                moveLabel="mover pra Exclusivo"
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
                  onMove={(id) => handleLineChange(id, "basico")}
                  onDelete={handleDeleteProduct}
                  onAdd={() =>
                    handleAddProduct({ ...newProductExclusivo, collection }, () =>
                      setNewProductExclusivo(emptyProductCost("exclusivo", collection)),
                    )
                  }
                  moveLabel="mover pra Básico"
                  showAddRow
                />
              ))}
            </>
          )}

          {tab === "profit" && (
            <div className="panel">
              <div className="panel-head">
                <div>
                  <div className="panel-title">Lucro por peça — {monthLabel(currentMonthStart())}</div>
                  <div className="panel-hint">Todas as peças vendidas no mês, ordenadas da maior pra menor margem.</div>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Peça</th>
                      <th className="num">Unid.</th>
                      <th className="num">Margem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pieceMargin.length === 0 && (
                      <tr>
                        <td colSpan={3} style={{ color: "var(--ink-faint)" }}>
                          Nenhuma venda ainda esse mês.
                        </td>
                      </tr>
                    )}
                    {pieceMargin.map((row) => (
                      <tr key={row.sku}>
                        <td className="sku">{row.sku}</td>
                        <td className="num">{row.units}</td>
                        <td className="num">
                          <span className={`margin-pill ${marginClass(row.marginPct)}`}>{row.marginPct.toFixed(1)}%</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
