import { useState } from "react";
import { TopBar, AdminBackLink } from "../components/TopBar";
import { SignOutButton } from "../components/RequireAuth";
import { monthlyOverhead, feeRates, productCosts, changeLog, monthlyDre } from "../data/mockData";
import type { OverheadRow } from "../data/mockData";

type Tab = "sku" | "fees" | "overhead";

function money(v: number) {
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const marketingPool = monthlyOverhead.filter((r) => r.isMarketing).reduce((sum, r) => sum + r.amount, 0);
const fixedPool = monthlyOverhead.filter((r) => !r.isMarketing).reduce((sum, r) => sum + r.amount, 0);

export function Admin() {
  const [tab, setTab] = useState<Tab>("overhead");
  const [overhead, setOverhead] = useState<OverheadRow[]>(monthlyOverhead);

  function updateAmount(id: string, value: string) {
    const parsed = Number(value.replace(/\./g, "").replace(",", "."));
    setOverhead((rows) => rows.map((r) => (r.id === id ? { ...r, amount: Number.isNaN(parsed) ? r.amount : parsed } : r)));
  }

  function updateMethod(id: string, method: OverheadRow["allocationMethod"]) {
    setOverhead((rows) => rows.map((r) => (r.id === id ? { ...r, allocationMethod: method } : r)));
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
      <p className="page-sub">
        Só o <b>Vitor</b> vê essa página — esses números não aparecem para os afiliados.
      </p>

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
          <span className="count">ago/26</span>
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
              <div className="as-label">Vendas do mês</div>
              <div className="as-value">
                {monthlyDre.salesSynced} vendas · R$ {monthlyDre.grossRevenue.toLocaleString("pt-BR")}
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <div>
                <div className="panel-title">Gastos do mês — Agosto 2026</div>
                <div className="panel-hint">
                  Cada gasto pode ser dividido de dois jeitos: igual entre todas as peças vendidas, ou proporcional ao valor de cada venda.
                </div>
              </div>
              <div className="month-picker">
                <button>‹</button>
                <span className="month">Ago 2026</span>
                <button>›</button>
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
                        <span className={`tag ${row.isMarketing ? "marketing" : "fixo"}`}>{row.isMarketing ? "marketing" : "fixo"}</span>
                      </td>
                      <td>{row.category}</td>
                      <td className="num">
                        <input className="cell-input" defaultValue={money(row.amount)} onBlur={(e) => updateAmount(row.id, e.target.value)} />
                      </td>
                      <td>
                        <select
                          className="cell-select"
                          value={row.allocationMethod}
                          onChange={(e) => updateMethod(row.id, e.target.value as OverheadRow["allocationMethod"])}
                        >
                          <option value="per_revenue">proporcional à venda</option>
                          <option value="per_unit">igual pra todas</option>
                        </select>
                      </td>
                      <td>
                        <div className="icon-cell">✕</div>
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td></td>
                    <td>
                      <input className="cell-text" placeholder="nome do novo gasto..." style={{ width: 180 }} />
                    </td>
                    <td className="num">
                      <input className="cell-input" defaultValue="0,00" />
                    </td>
                    <td>
                      <select className="cell-select">
                        <option value="per_unit">igual pra todas</option>
                        <option value="per_revenue">proporcional à venda</option>
                      </select>
                    </td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="toolbar">
              <button className="btn btn-ghost">Descartar</button>
              <button className="btn btn-primary">Salvar mês</button>
            </div>
          </div>
        </>
      )}

      {tab === "fees" && (
        <div className="panel">
          <div className="panel-head">
            <div>
              <div className="panel-title">Taxas de venda — atuais</div>
              <div className="panel-hint">Aplicadas em cima do valor de cada venda. Mudanças valem a partir da próxima atualização.</div>
            </div>
            <button className="btn btn-primary">Editar taxas</button>
          </div>
          <div className="form-grid">
            <div className="field">
              <label>Taxa Shopify</label>
              <input defaultValue={`${feeRates.taxaShopifyPct.toFixed(2)}%`} />
            </div>
            <div className="field">
              <label>Taxa do cartão</label>
              <input defaultValue={`${feeRates.taxaGatewayPct.toFixed(2)}%`} />
            </div>
            <div className="field">
              <label>Imposto (Simples)</label>
              <input defaultValue={`${feeRates.impostoPct.toFixed(2)}%`} />
            </div>
            <div className="field">
              <label>Comissão do influenciador</label>
              <input defaultValue={`${feeRates.comissaoInfluencerPct.toFixed(2)}%`} />
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
            <button className="btn btn-primary">+ nova peça</button>
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
                </tr>
              </thead>
              <tbody>
                {productCosts.map((p) => {
                  const total = p.tecido + p.estampa + p.costura + p.sacolinha + p.adesivo + p.outros;
                  return (
                    <tr key={p.sku}>
                      <td className="sku">
                        {p.productName}
                        <span className="sku-id">{p.sku}</span>
                      </td>
                      <td className="num">
                        <input className="cell-input" defaultValue={money(p.tecido)} />
                      </td>
                      <td className="num">
                        <input className="cell-input" defaultValue={money(p.estampa)} />
                      </td>
                      <td className="num">
                        <input className="cell-input" defaultValue={money(p.costura)} />
                      </td>
                      <td className="num">
                        <input className="cell-input" defaultValue={money(p.sacolinha)} />
                      </td>
                      <td className="num">
                        <input className="cell-input" defaultValue={money(p.adesivo)} />
                      </td>
                      <td className="num">
                        <input className="cell-input" defaultValue={money(p.outros)} />
                      </td>
                      <td className="num total-cell">{money(total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <div>
            <div className="panel-title">O que mudou</div>
            <div className="panel-hint">Últimas mudanças nos números.</div>
          </div>
        </div>
        <div className="panel-body" style={{ padding: "6px 18px 16px" }}>
          {changeLog.map((entry, i) => (
            <div className="audit-row" key={i}>
              <span className="audit-who">{entry.who}</span>
              <span className="audit-when">{entry.when}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
