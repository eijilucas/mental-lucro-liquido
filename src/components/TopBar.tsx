import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export function TopBar({ subtitle, children }: { subtitle: string; children?: ReactNode }) {
  return (
    <div className="topbar">
      <div className="brand">
        <HubLogoLink />
        <span className="brand-mark">Mental Madness</span>
        <span className="brand-sep">/</span>
        <span className="brand-app">{subtitle}</span>
      </div>
      {children}
    </div>
  );
}

// Logo leva pro Hub, a central que lista todos os sistemas da Mental Madness —
// mesmo comportamento da logo do painel de comissionamento.
export function HubLogoLink() {
  return (
    <a
      href="https://mental-madness-hub.vercel.app/"
      target="_blank"
      rel="noopener noreferrer"
      className="brand-logo-link"
      aria-label="Abrir o Hub Mental Madness"
      title="Hub Mental Madness"
    >
      <img src="/logo-m.png" alt="" className="brand-logo" />
    </a>
  );
}

export function AdminBackLink() {
  return (
    <Link className="back-link" to="/">
      ← voltar ao dashboard
    </Link>
  );
}

export function AdminLink() {
  return (
    <Link className="icon-btn" to="/admin" title="Administração">
      ⚙
    </Link>
  );
}
