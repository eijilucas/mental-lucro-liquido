import { useEffect, useState } from "react";
import { TopBar, AdminLink } from "../components/TopBar";
import { SignOutButton } from "../components/RequireAuth";
import {
  fetchMonthlyDre,
  fetchPreviousMonthDre,
  fetchRecentSales,
  fetchSkuMarginForMonth,
  fetchLastSyncTime,
  currentMonthStart,
  type MonthlyDreRow,
  type SaleMarginRow,
} from "../lib/queries";
import { supabase } from "../lib/supabase";

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
function monthLabel(monthStr: string) {
  const [y, m] = monthStr.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
}
function timeAgo(iso: string) {
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return "agora";
  if (diffMin < 60) return `há ${diffMin} min`;
  const hours = Math.round(diffMin / 60);
  return `há ${hours}h`;
}

interface DashboardData {
  dre: MonthlyDreRow;
  prevDre: MonthlyDreRow | null;
  recentSales: SaleMarginRow[];
  skuMargin: { sku: string; units: number; marginPct: number }[];
  lastSync: string | null;
}

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [dre, prevDre, recentSales, skuMargin, lastSync] = await Promise.all([
          fetchMonthlyDre(),
          fetchPreviousMonthDre(),
          fetchRecentSales(5),
          fetchSkuMarginForMonth(),
          fetchLastSyncTime(),
        ]);
        if (cancelled) return;
        if (!dre) {
          setError(`Ainda não há vendas sincronizadas para ${monthLabel(currentMonthStart())}.`);
          return;
        }
        setData({ dre, prevDre, recentSales, skuMargin, lastSync });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Erro ao carregar dados.");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!supabase) {
    return (
      <div className="app">
        <p className="page-sub">Supabase não configurado — faltam as variáveis de ambiente (.env).</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="app">
        <TopBar subtitle="lucro líquido">
          <div className="topbar-controls">
            <AdminLink />
            <SignOutButton />
          </div>
        </TopBar>
        <p className="page-sub">{error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="app">
        <p className="page-sub">Carregando...</p>
      </div>
    );
  }

  const { dre, prevDre, recentSales, skuMargin, lastSync } = data;
  const totalCost = dre.direct_cost + dre.sale_cost + dre.marketing_cost + dre.fixed_cost;
  const afterDirect = dre.gross_revenue - dre.direct_cost;
  const afterSaleCost = afterDirect - dre.sale_cost;
  const afterMarketing = afterSaleCost - dre.marketing_cost;
  const netMarginPct = dre.gross_revenue > 0 ? (dre.net_profit / dre.gross_revenue) * 100 : 0;
  const grossDeltaPct = prevDre && prevDre.gross_revenue > 0 ? ((dre.gross_revenue - prevDre.gross_revenue) / prevDre.gross_revenue) * 100 : null;

  function waterfallWidth(value: number) {
    return `${dre.gross_revenue > 0 ? ((value / dre.gross_revenue) * 100).toFixed(1) : 0}%`;
  }

  return (
    <div className="app">
      <TopBar subtitle="lucro líquido">
        <div className="topbar-controls">
          <AdminLink />
          <SignOutButton />
        </div>
      </TopBar>

      <h1 className="page-title">Visão geral — {monthLabel(dre.month)}</h1>
      <p className="page-sub">
        {recentSales.length} vendas recentes
        {lastSync ? <> · última sincronização {timeAgo(lastSync)}</> : null}
      </p>

      <div className="kpi-row" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        <div className="kpi">
          <div className="kpi-label">Faturamento</div>
          <div className="kpi-value">R$ {money(dre.gross_revenue)}</div>
          {grossDeltaPct !== null && (
            <div className={`kpi-delta ${grossDeltaPct >= 0 ? "up" : "down"}`}>
              {grossDeltaPct >= 0 ? "↑" : "↓"} {Math.abs(grossDeltaPct).toFixed(1)}% vs mês anterior
            </div>
          )}
        </div>
        <div className="kpi">
          <div className="kpi-label">Custos totais</div>
          <div className="kpi-value">R$ {money(totalCost)}</div>
          <div className="kpi-delta down">{dre.gross_revenue > 0 ? ((totalCost / dre.gross_revenue) * 100).toFixed(1) : 0}% do fat.</div>
        </div>
        <div className="kpi hero">
          <div className="kpi-label">Lucro líquido</div>
          <div className="kpi-value">R$ {money(dre.net_profit)}</div>
          <div className="kpi-delta up">margem {netMarginPct.toFixed(1)}%</div>
        </div>
      </div>

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
              <div className="wf-value">R$ {moneyCents(dre.gross_revenue)}</div>
            </div>
            <div className="wf-cut">− R$ {moneyCents(dre.direct_cost)} · custo direto</div>
            <div className="wf-row">
              <div className="wf-label">Após custo direto</div>
              <div className="wf-track">
                <div className="wf-fill" style={{ width: waterfallWidth(afterDirect) }} />
              </div>
              <div className="wf-value">R$ {moneyCents(afterDirect)}</div>
            </div>
            <div className="wf-cut">− R$ {moneyCents(dre.sale_cost)} · custos da venda</div>
            <div className="wf-row">
              <div className="wf-label">Após custos da venda</div>
              <div className="wf-track">
                <div className="wf-fill" style={{ width: waterfallWidth(afterSaleCost) }} />
              </div>
              <div className="wf-value">R$ {moneyCents(afterSaleCost)}</div>
            </div>
            <div className="wf-cut">− R$ {moneyCents(dre.marketing_cost)} · marketing rateado</div>
            <div className="wf-row">
              <div className="wf-label">Após marketing</div>
              <div className="wf-track">
                <div className="wf-fill" style={{ width: waterfallWidth(afterMarketing) }} />
              </div>
              <div className="wf-value">R$ {moneyCents(afterMarketing)}</div>
            </div>
            <div className="wf-cut">− R$ {moneyCents(dre.fixed_cost)} · fixos rateados</div>
            <div className="wf-row">
              <div className="wf-label strong">Lucro líquido</div>
              <div className="wf-track">
                <div className="wf-fill final" style={{ width: waterfallWidth(dre.net_profit) }} />
              </div>
              <div className="wf-value final">R$ {moneyCents(dre.net_profit)}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid">
        <div className="col">
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
                    <th className="num">Líquido</th>
                    <th className="num">Margem</th>
                  </tr>
                </thead>
                <tbody>
                  {recentSales.length === 0 && (
                    <tr>
                      <td colSpan={4} style={{ color: "var(--ink-faint)" }}>
                        Nenhuma venda ainda.
                      </td>
                    </tr>
                  )}
                  {recentSales.map((s) => {
                    const marginPct = s.gross_amount > 0 ? (s.net_profit / s.gross_amount) * 100 : 0;
                    return (
                      <tr key={`${s.sale_id}-${s.product_sku}`}>
                        <td className="sku">
                          {s.product_name}
                          <span className="sku-id">{s.product_sku}</span>
                        </td>
                        <td className="num">{moneyCents(s.gross_amount)}</td>
                        <td className="num">{moneyCents(s.net_profit)}</td>
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
              <span className="panel-hint">{monthLabel(dre.month)}</span>
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
        </div>
      </div>
    </div>
  );
}
