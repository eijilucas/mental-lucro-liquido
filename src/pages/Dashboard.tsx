import { useEffect, useState } from "react";
import { TopBar, AdminLink } from "../components/TopBar";
import { SignOutButton } from "../components/RequireAuth";
import { DateRangePicker } from "../components/DateRangePicker";
import {
  fetchSaleMarginForRange,
  fetchLastSyncTime,
  currentMonthStart,
  todayStr,
  previousPeriod,
  type SaleMarginRow,
} from "../lib/queries";
import { supabase } from "../lib/supabase";

function money(v: number) {
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function moneyCents(v: number) {
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function dateLabel(dateStr: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}
function rangeLabel(start: string, end: string) {
  const startYear = start.slice(0, 4);
  const endYear = end.slice(0, 4);
  if (start === end) return `${dateLabel(start)}/${endYear}`;
  return startYear === endYear ? `${dateLabel(start)} a ${dateLabel(end)}/${endYear}` : `${dateLabel(start)}/${startYear} a ${dateLabel(end)}/${endYear}`;
}
function timeAgo(iso: string) {
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return "agora";
  if (diffMin < 60) return `há ${diffMin} min`;
  const hours = Math.round(diffMin / 60);
  return `há ${hours}h`;
}

interface DreTotals {
  gross_revenue: number;
  direct_cost: number;
  sale_cost: number;
  marketing_cost: number;
  fixed_cost: number;
  net_profit: number;
}

function aggregateDre(rows: SaleMarginRow[]): DreTotals {
  return rows.reduce<DreTotals>(
    (acc, r) => ({
      gross_revenue: acc.gross_revenue + r.gross_amount,
      direct_cost: acc.direct_cost + r.direct_cost,
      sale_cost: acc.sale_cost + r.sale_cost,
      marketing_cost: acc.marketing_cost + r.marketing_cost,
      fixed_cost: acc.fixed_cost + r.fixed_cost,
      net_profit: acc.net_profit + r.net_profit,
    }),
    { gross_revenue: 0, direct_cost: 0, sale_cost: 0, marketing_cost: 0, fixed_cost: 0, net_profit: 0 },
  );
}

function DreWaterfall({ title, hint, dre }: { title: string; hint: string; dre: DreTotals }) {
  const afterDirect = dre.gross_revenue - dre.direct_cost;
  const afterSaleCost = afterDirect - dre.sale_cost;
  const afterMarketing = afterSaleCost - dre.marketing_cost;

  function waterfallWidth(value: number) {
    return `${dre.gross_revenue > 0 ? ((value / dre.gross_revenue) * 100).toFixed(1) : 0}%`;
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">{title}</span>
        <span className="panel-hint">{hint}</span>
      </div>
      <div className="panel-body">
        {dre.gross_revenue === 0 ? (
          <p className="page-sub" style={{ margin: 0 }}>Nenhuma venda dessa linha no período.</p>
        ) : (
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
        )}
      </div>
    </div>
  );
}

interface DashboardData {
  dre: DreTotals;
  prevDre: DreTotals | null;
  basicoDre: DreTotals;
  exclusivoDre: DreTotals;
  lastSync: string | null;
}

export function Dashboard() {
  const [rangeStart, setRangeStart] = useState(currentMonthStart());
  const [rangeEnd, setRangeEnd] = useState(todayStr());
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const prev = previousPeriod(rangeStart, rangeEnd);
        const [rows, prevRows, lastSync] = await Promise.all([
          fetchSaleMarginForRange(rangeStart, rangeEnd),
          fetchSaleMarginForRange(prev.start, prev.end),
          fetchLastSyncTime(),
        ]);
        if (cancelled) return;
        const dre = aggregateDre(rows);
        const prevDre = prevRows.length > 0 ? aggregateDre(prevRows) : null;
        const basicoDre = aggregateDre(rows.filter((r) => r.product_line === "basico"));
        const exclusivoDre = aggregateDre(rows.filter((r) => r.product_line === "exclusivo"));
        setData({ dre, prevDre, basicoDre, exclusivoDre, lastSync });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Erro ao carregar dados.");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [rangeStart, rangeEnd]);

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
        <TopBar subtitle="jackpot">
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

  const { dre, prevDre, basicoDre, exclusivoDre, lastSync } = data;
  const totalCost = dre.direct_cost + dre.sale_cost + dre.marketing_cost + dre.fixed_cost;
  const netMarginPct = dre.gross_revenue > 0 ? (dre.net_profit / dre.gross_revenue) * 100 : 0;
  const grossDeltaPct = prevDre && prevDre.gross_revenue > 0 ? ((dre.gross_revenue - prevDre.gross_revenue) / prevDre.gross_revenue) * 100 : null;

  return (
    <div className="app">
      <TopBar subtitle="jackpot">
        <div className="topbar-controls">
          <AdminLink />
          <SignOutButton />
        </div>
      </TopBar>

      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 24 }}>
        <div>
          <h1 className="page-title">Visão geral — {rangeLabel(rangeStart, rangeEnd)}</h1>
          {lastSync && <p className="page-sub">última sincronização {timeAgo(lastSync)}</p>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <DateRangePicker
            start={rangeStart}
            end={rangeEnd}
            maxDate={todayStr()}
            onChange={(s, e) => { setRangeStart(s); setRangeEnd(e); }}
          />
          <button type="button" className="btn btn-ghost" onClick={() => { setRangeStart(currentMonthStart()); setRangeEnd(todayStr()); }}>
            Mês atual
          </button>
        </div>
      </div>

      <div className="kpi-row" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        <div className="kpi">
          <div className="kpi-label">Faturamento</div>
          <div className="kpi-value">R$ {money(dre.gross_revenue)}</div>
          {prevDre && (
            <div className={`kpi-delta ${grossDeltaPct !== null && grossDeltaPct >= 0 ? "up" : "down"}`}>
              R$ {money(prevDre.gross_revenue)} período anterior
              {grossDeltaPct !== null && <> · {grossDeltaPct >= 0 ? "↑" : "↓"} {Math.abs(grossDeltaPct).toFixed(1)}%</>}
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

      <DreWaterfall title="DRE do período — Total" hint="faturamento → lucro líquido · drop básico + exclusivos" dre={dre} />
      <DreWaterfall title="DRE do período — Drop Básico" hint="só as peças marcadas como linha básica" dre={basicoDre} />
      <DreWaterfall title="DRE do período — Exclusivos" hint="só as peças marcadas como linha exclusiva" dre={exclusivoDre} />
    </div>
  );
}
