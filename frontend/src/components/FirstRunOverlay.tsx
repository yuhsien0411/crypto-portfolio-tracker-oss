import { useNavigate } from "react-router-dom";
import { useTranslation } from "../i18n/useTranslation";

/**
 * Full-screen blurred overlay for brand-new users with zero accounts.
 * Non-dismissable by design — the only way forward is the CTA, which sends
 * them to Manage Accounts with state that auto-opens the Add panel.
 */
export function FirstRunOverlay() {
  const navigate = useNavigate();
  const t = useTranslation();

  const startAdd = () => {
    navigate("/accounts", { state: { openAdd: true } });
  };

  return (
    <div
      className="first-run-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="first-run-title"
    >
      <div className="first-run-card">
        <div className="section-eyebrow" style={{ marginBottom: 10 }}>
          {t.firstRun.eyebrow}
        </div>
        <h2 id="first-run-title" className="head" style={{ fontSize: 30, margin: 0 }}>
          {t.firstRun.title}
        </h2>
        <p className="first-run-sub">{t.firstRun.sub}</p>

        <ul className="first-run-list">
          <li>
            <span className="src chain">{t.firstRun.chainBadge}</span>
            {t.firstRun.chainItem}
          </li>
          <li>
            <span className="src cex">{t.firstRun.cexBadge}</span>
            {t.firstRun.cexItem}
          </li>
          <li>
            <span className="src perp">{t.firstRun.perpBadge}</span>
            {t.firstRun.perpItem}
          </li>
          <li>
            <span className="src manual">{t.firstRun.manualBadge}</span>
            {t.firstRun.manualItem}
          </li>
        </ul>

        <button
          className="wbtn primary first-run-cta"
          onClick={startAdd}
          autoFocus
        >
          {t.firstRun.cta}
        </button>
      </div>
    </div>
  );
}
