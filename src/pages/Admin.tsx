import { useEffect, useState } from "react";
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
  deleteProductCost,
  insertProductCost,
  currentMonthStart,
  type OverheadRow,
  type FeeRatesRow,
  type ProductCostRow,
} from "../lib/queries";

type Tab = "sku" | "fees" | "overhead";

function money(v: number) {
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function parseMoney(value: string): number | null {
  const parsed = Number(value.replace(/\./g, "").replace(",", "."));
  return Number.isNaN(parsed) ? null : parsed;
}
function monthLabel(monthStr: string) {
  const [y, m] = monthStr.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("pt-BR", { month: "short", year: "numeric" });
}

const emptyProductCost: ProductCostRow = {
  sku: "",
  product_name: "",
  tecido: 0,
  estampa: 0,
  costura: 0,
  sacolinha: 0,
  adesivo: 0,
  outros_acabamentos: 0,
};

export function Admin() {
  const [tab, setTab] = useState<Tab>("overhead");
  const [overhead, setOverhead] = useState<OverheadRow[]>([]);
  const [feeRates, setFeeRates] = useState<FeeRatesRow | null>(null);
  const [productCosts, setProductCosts] = useState<ProductCostRow[]>([]);
  const [newOverhead, setNewOverhead] = useState({ category: "", amount: "0,00", isMarketing: false, method: "per_unit" as OverheadRow["allocation_method"] });
  const [newProduct, setNewProduct] = useState<ProductCostRow>(emptyProductCost);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [overheadRows, rates, costs] = await Promise.all([fetchMonthlyOverhead(), fetchFeeRates(), fetchProductCosts()]);
        if (cancelled) return;
        setOverhead(overheadRows);
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

  async function handleAddOverhead() {
    const amount = parseMoney(newOverhead.amount) ?? 0;
    if (!newOverhead.category.trim()) return;
    const row = await insertOverhead({
      category: newOverhead.category.trim(),
      amount,
      is_marketing: newOverhead.isMarketing,
      allocation_method: newOverhead.method,
    });
    setOverhead((rows) => [...rows, row]);
    setNewOverhead({ category: "", amount: "0,00", isMarketing: false, method: "per_unit" });
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
  }

  async function handleProductCostBlur(sku: string, field: keyof Omit<ProductCostRow, "sku" | "product_name">, value: string) {
    const parsed = parseMoney(value);
    if (parsed === null) return;
    setProductCosts((rows) => rows.map((r) => (r.sku === sku ? { ...r, [field]: parsed } : r)));
    await updateProductCost(sku, field, parsed);
  }

  async function handleAddProduct() {
    if (!newProduct.sku.trim() || !newProduct.product_name.trim()) return;
    const row = await insertProductCost(newProduct);
    setProductCosts((rows) => [...rows, row]);
    setNewProduct(emptyProductCost);
  }

  async function handleProductNameBlur(sku: string, value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    setProductCosts((rows) => rows.map((r) => (r.sku === sku ? { ...r, product_name: trimmed } : r)));
    await updateProductName(sku, trimmed);
  }

  async function handleDeleteProduct(sku: string) {
    setProductCosts((rows) => rows.filter((r) => r.sku !== sku));
    await deleteProductCost(sku);
  }

  const marketingPool = overhead.filter((r) => r.is_marketing).reduce((sum, r) => sum + r.amount, 0);
  const fixedPool = overhead.filter((r) => !r.is_marketing).reduce((sum, r) => sum + r.amount, 0);

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
              <span className="count">{productCosts.length}</span>
            </div>
            <div className={`tab ${tab === "fees" ? "active" : ""}`} onClick={() => setTab("fees")}>
              Taxas de venda
            </div>
            <div className={`tab ${tab === "overhead" ? "active" : ""}`} onClick={() => setTab("overhead")}>
              Gastos do mês
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
                    <div className="panel-title">Gastos do mês — {monthLabel(currentMonthStart())}</div>
                    <div className="panel-hint">
                      Cada gasto pode ser dividido de dois jeitos: igual entre todas as peças vendidas, ou proporcional ao valor de cada venda.
                    </div>
                  </div>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: 80 }}>Tipo</th>
                        <th>Nome do gasto</th>
                        <th className="num" style={{ width: 120 }}>Valor</th>
                        <th style={{ width: 170 }}>Como dividir</th>
                        <th style={{ width: 40 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {overhead.map((row) => (
                        <tr key={row.id}>
                          <td>
                            <span className={`tag ${row.is_marketing ? "marketing" : "fixo"}`}>{row.is_marketing ? "marketing" : "fixo"}</span>
                          </td>
                          <td>{row.category}</td>
                          <td className="num">
                            <input className="cell-input" defaultValue={money(row.amount)} onBlur={(e) => handleAmountBlur(row.id, e.target.value)} />
                          </td>
                          <td>
                            <select
                              className="cell-select"
                              value={row.allocation_method}
                              onChange={(e) => handleMethodChange(row.id, e.target.value as OverheadRow["allocation_method"])}
                            >
                              <option value="per_revenue">proporcional à venda</option>
                              <option value="per_unit">igual pra todas</option>
                            </select>
                          </td>
                          <td>
                            <div className="icon-cell" onClick={() => handleDeleteOverhead(row.id)}>✕</div>
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td>
                          <select
                            className="cell-select"
                            value={newOverhead.isMarketing ? "marketing" : "fixo"}
                            onChange={(e) => setNewOverhead((s) => ({ ...s, isMarketing: e.target.value === "marketing" }))}
                          >
                            <option value="fixo">fixo</option>
                            <option value="marketing">marketing</option>
                          </select>
                        </td>
                        <td>
                          <input
                            className="cell-text"
                            placeholder="nome do novo gasto..."
                            style={{ width: 180 }}
                            value={newOverhead.category}
                            onChange={(e) => setNewOverhead((s) => ({ ...s, category: e.target.value }))}
                          />
                        </td>
                        <td className="num">
                          <input
                            className="cell-input"
                            value={newOverhead.amount}
                            onChange={(e) => setNewOverhead((s) => ({ ...s, amount: e.target.value }))}
                          />
                        </td>
                        <td>
                          <select
                            className="cell-select"
                            value={newOverhead.method}
                            onChange={(e) => setNewOverhead((s) => ({ ...s, method: e.target.value as OverheadRow["allocation_method"] }))}
                          >
                            <option value="per_unit">igual pra todas</option>
                            <option value="per_revenue">proporcional à venda</option>
                          </select>
                        </td>
                        <td>
                          <div className="icon-cell" onClick={handleAddOverhead}>+</div>
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
                <button className="btn btn-primary" onClick={handleFeeRatesSave}>Salvar</button>
              </div>
              <div className="form-grid">
                <div className="field">
                  <label>Taxa Shopify</label>
                  <input
                    defaultValue={`${(feeRates.taxa_shopify_pct * 100).toFixed(2)}%`}
                    onBlur={(e) => {
                      const v = parseMoney(e.target.value.replace("%", ""));
                      if (v !== null) setFeeRates({ ...feeRates, taxa_shopify_pct: v / 100 });
                    }}
                  />
                </div>
                <div className="field">
                  <label>Taxa do cartão</label>
                  <input
                    defaultValue={`${(feeRates.taxa_gateway_pct * 100).toFixed(2)}%`}
                    onBlur={(e) => {
                      const v = parseMoney(e.target.value.replace("%", ""));
                      if (v !== null) setFeeRates({ ...feeRates, taxa_gateway_pct: v / 100 });
                    }}
                  />
                </div>
                <div className="field">
                  <label>Imposto (Simples)</label>
                  <input
                    defaultValue={`${(feeRates.imposto_pct * 100).toFixed(2)}%`}
                    onBlur={(e) => {
                      const v = parseMoney(e.target.value.replace("%", ""));
                      if (v !== null) setFeeRates({ ...feeRates, imposto_pct: v / 100 });
                    }}
                  />
                </div>
                <div className="field">
                  <label>Comissão do influenciador</label>
                  <input
                    defaultValue={`${(feeRates.comissao_influencer_pct * 100).toFixed(2)}%`}
                    onBlur={(e) => {
                      const v = parseMoney(e.target.value.replace("%", ""));
                      if (v !== null) setFeeRates({ ...feeRates, comissao_influencer_pct: v / 100 });
                    }}
                  />
                  <div className="suffix">mesma taxa do painel de comissão</div>
                </div>
              </div>
            </div>
          )}

          {tab === "sku" && (
            <div className="panel">
              <div className="panel-head">
                <div>
                  <div className="panel-title">Custo de cada peça</div>
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
                      <th style={{ width: 40 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {productCosts.map((p) => {
                      const total = p.tecido + p.estampa + p.costura + p.sacolinha + p.adesivo + p.outros_acabamentos;
                      return (
                        <tr key={p.sku}>
                          <td className="sku">
                            <input
                              className="cell-text"
                              defaultValue={p.product_name}
                              onBlur={(e) => handleProductNameBlur(p.sku, e.target.value)}
                              style={{ width: 160, display: "block", marginBottom: 4 }}
                            />
                            <span className="sku-id">{p.sku}</span>
                          </td>
                          <td className="num">
                            <input className="cell-input" defaultValue={money(p.tecido)} onBlur={(e) => handleProductCostBlur(p.sku, "tecido", e.target.value)} />
                          </td>
                          <td className="num">
                            <input className="cell-input" defaultValue={money(p.estampa)} onBlur={(e) => handleProductCostBlur(p.sku, "estampa", e.target.value)} />
                          </td>
                          <td className="num">
                            <input className="cell-input" defaultValue={money(p.costura)} onBlur={(e) => handleProductCostBlur(p.sku, "costura", e.target.value)} />
                          </td>
                          <td className="num">
                            <input className="cell-input" defaultValue={money(p.sacolinha)} onBlur={(e) => handleProductCostBlur(p.sku, "sacolinha", e.target.value)} />
                          </td>
                          <td className="num">
                            <input className="cell-input" defaultValue={money(p.adesivo)} onBlur={(e) => handleProductCostBlur(p.sku, "adesivo", e.target.value)} />
                          </td>
                          <td className="num">
                            <input className="cell-input" defaultValue={money(p.outros_acabamentos)} onBlur={(e) => handleProductCostBlur(p.sku, "outros_acabamentos", e.target.value)} />
                          </td>
                          <td className="num total-cell">{money(total)}</td>
                          <td>
                            <div className="icon-cell" onClick={() => handleDeleteProduct(p.sku)}>✕</div>
                          </td>
                        </tr>
                      );
                    })}
                    <tr>
                      <td className="sku">
                        <input
                          className="cell-text"
                          placeholder="SKU"
                          style={{ width: 90 }}
                          value={newProduct.sku}
                          onChange={(e) => setNewProduct((s) => ({ ...s, sku: e.target.value }))}
                        />
                        <input
                          className="cell-text"
                          placeholder="nome da peça"
                          style={{ width: 140, marginTop: 4 }}
                          value={newProduct.product_name}
                          onChange={(e) => setNewProduct((s) => ({ ...s, product_name: e.target.value }))}
                        />
                      </td>
                      {(["tecido", "estampa", "costura", "sacolinha", "adesivo", "outros_acabamentos"] as const).map((field) => (
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
                      <td className="num total-cell">
                        {money(newProduct.tecido + newProduct.estampa + newProduct.costura + newProduct.sacolinha + newProduct.adesivo + newProduct.outros_acabamentos)}
                      </td>
                      <td>
                        <div className="icon-cell" onClick={handleAddProduct}>+</div>
                      </td>
                    </tr>
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
