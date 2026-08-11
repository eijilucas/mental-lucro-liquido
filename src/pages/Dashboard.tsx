import { TopBar, AdminLink } from "../components/TopBar";
import { SignOutButton } from "../components/RequireAuth";
import { recentSales, monthlyDre, skuMargin, monthlyOverhead } from "../data/mockData";

function money(v: number) {
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function moneyCents(v: number) {
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function marginClass(pct: number) {
  if (pct >= 32) return "good";
  if (pct >= 24) return "mid";
  return "low";
}

const dre = monthlyDre;
const afterDirect = dre.grossRevenue - dre.directCost;
const afterSaleCost = afterDirect - dre.saleCost;
const afterMarketing = afterSaleCost - dre.marketingCost;
const netMarginPct = (dre.netProfit / dre.grossRevenue) * 100;

function waterfallWidth(value: number) {
  return `${((value / dre.grossRevenue) * 100).toFixed(1)}%`;
}

export function Dashboard() {
  return (
    <div className="app">
      <TopBar subtitle="lucro líquido">
        <div className="topbar-controls">
          <div className="seg">
            <button>7d</button>
            <button className="active">Ago 2026</button>
            <button>Trimestre</button>
          </div>
          <div className="icon-btn" title="Exportar">
            ⇩
          </div>
          <AdminLink />
          <SignOutButton />
        </div>
      </TopBar>

      <h1 className="page-title">Visão geral — {dre.month}</h1>
      <p className="page-sub">
        {dre.salesSynced} vendas sincronizadas de <b>sales / sale_items</b> · última sincronização há 22 min
      </p>

      <div className="kpi-row">
        <div className="kpi">
          <div className="kpi-label">Faturamento</div>
          <div className="kpi-value">R$ {money(dre.grossRevenue)}</div>
          <div className="kpi-delta up">↑ 8,4% vs jul</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Custo direto</div>
          <div className="kpi-value">R$ {money(dre.directCost)}</div>
          <div className="kpi-delta down">{((dre.directCost / dre.grossRevenue) * 100).toFixed(1)}% do fat.</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Custos da venda</div>
          <div className="kpi-value">R$ {money(dre.saleCost)}</div>
          <div className="kpi-delta down">{((dre.saleCost / dre.grossRevenue) * 100).toFixed(1)}% do fat.</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Marketing rateado</div>
          <div className="kpi-value">R$ {money(dre.marketingCost)}</div>
          <div className="kpi-delta down">{((dre.marketingCost / dre.grossRevenue) * 100).toFixed(1)}% do fat.</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Fixos rateados</div>
          <div className="kpi-value">R$ {money(dre.fixedCost)}</div>
          <div className="kpi-delta down">{((dre.fixedCost / dre.grossRevenue) * 100).toFixed(1)}% do fat.</div>
        </div>
        <div className="kpi hero">
          <div className="kpi-label">Lucro líquido</div>
          <div className="kpi-value">R$ {money(dre.netProfit)}</div>
          <div className="kpi-delta up">margem {netMarginPct.toFixed(1)}%</div>
        </div>
      </div>

      <div className="grid">
        <div className="col">
          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">DRE do mês</span>
              <span className="panel-hint">faturamento → lucro líquido</span>
            </div>
            <div className="panel-body">
              <div className="waterfall">
                <div className="wf-row">
                  <div className="wf-label strong">Faturamento</div>
                  <div className="wf-track">
                    <div className="wf-fill neutral" style={{ width: "100%" }} />
                  </div>
                  <div className="wf-value">R$ {moneyCents(dre.grossRevenue)}</div>
                </div>
                <div className="wf-cut">− R$ {moneyCents(dre.directCost)} · custo direto (tecido, estampa, costura...)</div>
                <div className="wf-row">
                  <div className="wf-label">Após custo direto</div>
                  <div className="wf-track">
                    <div className="wf-fill" style={{ width: waterfallWidth(afterDirect) }} />
                  </div>
                  <div className="wf-value">R$ {moneyCents(afterDirect)}</div>
                </div>
                <div className="wf-cut">− R$ {moneyCents(dre.saleCost)} · taxa Shopify + gateway + imposto + comissão</div>
                <div className="wf-row">
                  <div className="wf-label">Após custos da venda</div>
                  <div className="wf-track">
                    <div className="wf-fill" style={{ width: waterfallWidth(afterSaleCost) }} />
                  </div>
                  <div className="wf-value">R$ {moneyCents(afterSaleCost)}</div>
                </div>
                <div className="wf-cut">− R$ {moneyCents(dre.marketingCost)} · marketing rateado (tráfego + influenciadores)</div>
                <div className="wf-row">
                  <div className="wf-label">Após marketing</div>
                  <div className="wf-track">
                    <div className="wf-fill" style={{ width: waterfallWidth(afterMarketing) }} />
                  </div>
                  <div className="wf-value">R$ {moneyCents(afterMarketing)}</div>
                </div>
                <div className="wf-cut">− R$ {moneyCents(dre.fixedCost)} · fixos rateados (plataforma, folha, contabilidade...)</div>
                <div className="wf-row">
                  <div className="wf-label strong">Lucro líquido</div>
                  <div className="wf-track">
                    <div className="wf-fill final" style={{ width: waterfallWidth(dre.netProfit) }} />
                  </div>
                  <div className="wf-value final">R$ {moneyCents(dre.netProfit)}</div>
                </div>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">Vendas recentes</span>
              <span className="panel-hint">margem por venda</span>
            </div>
            <div className="panel-body table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th className="num">Bruto</th>
                    <th className="num">Custo direto</th>
                    <th className="num">Custos venda</th>
                    <th className="num">Rateio</th>
                    <th className="num">Líquido</th>
                    <th className="num">Margem</th>
                  </tr>
                </thead>
                <tbody>
                  {recentSales.map((s) => {
                    const marginPct = (s.netProfit / s.grossAmount) * 100;
                    return (
                      <tr key={s.saleId}>
                        <td className="sku">
                          {s.productName}
                          <span className="sku-id">{s.productSku}</span>
                        </td>
                        <td className="num">{moneyCents(s.grossAmount)}</td>
                        <td className="num">{moneyCents(s.directCost)}</td>
                        <td className="num">{moneyCents(s.saleCost)}</td>
                        <td className="num">{moneyCents(s.marketingCost + s.fixedCost)}</td>
                        <td className="num">{moneyCents(s.netProfit)}</td>
                        <td className="num">
                          <span className={`margin-pill ${marginClass(marginPct)}`}>{marginPct.toFixed(1)}%</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="col">
          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">Margem por SKU</span>
              <span className="panel-hint">ago/2026</span>
            </div>
            <div className="panel-body table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th className="num">Unid.</th>
                    <th className="num">Margem</th>
                  </tr>
                </thead>
                <tbody>
                  {skuMargin.map((row) => (
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

          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">Rateio do mês</span>
              <span className="panel-hint">método por categoria</span>
            </div>
            <div className="panel-body">
              <div className="rateio-list">
                {monthlyOverhead.map((row) => (
                  <div className="rateio-item" key={row.id}>
                    <div className="rateio-name">
                      {row.category}
                      <span className="rateio-sub">
                        {row.isMarketing ? "marketing" : "fixo"} · {row.allocationMethod === "per_revenue" ? "por faturamento" : "por unidade"}
                      </span>
                    </div>
                    <span className="method-pill">
                      {row.allocationMethod === "per_revenue" ? "proporcional à venda" : "igual pra todas"}
                    </span>
                    <div className="rateio-amt">R$ {money(row.amount)}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="sync-strip">
              <span className="sync-dot" />
              <span>
                <b>Projeto A</b> no ar — sincronizado há 22 min
              </span>
              <span className="src">read-only · 1×/hora</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
