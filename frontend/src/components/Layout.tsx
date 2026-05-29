import { NavLink, Outlet, useLocation } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth/AuthContext";
import { useApi } from "../hooks/useApi";
import { useTranslation } from "../i18n/useTranslation";
import { FirstRunOverlay } from "./FirstRunOverlay";
import { UserMenu } from "./UserMenu";

interface Tab {
  id: string;
  labelKey: "dashboard" | "accounts" | "balance" | "cashflow";
  end?: boolean;
}

const TABS: Tab[] = [
  { id: "/", labelKey: "dashboard", end: true },
  { id: "/accounts", labelKey: "accounts" },
  // Temporarily hidden — work in progress
  // { id: "/balance", labelKey: "balance" },
  // { id: "/cashflow", labelKey: "cashflow" },
];

// Pages where the first-run overlay should NOT block: these are where a new
// user actually configures their first account.
const ONBOARDING_PATHS = new Set(["/accounts"]);

export function Layout() {
  const { user } = useAuth();
  const location = useLocation();
  const t = useTranslation();

  // Re-fetch on every navigation so adding an account elsewhere immediately
  // dismisses the overlay when the user returns. Cache key is shared with
  // the pages so they all read the same list without a visible flash.
  const accounts = useApi(
    () => api.listAccounts(),
    [location.pathname],
    "accounts:list",
  );

  const isOnboardingPath = ONBOARDING_PATHS.has(location.pathname);
  const showFirstRun =
    !accounts.loading && (accounts.data?.length ?? 0) === 0 && !isOnboardingPath;

  return (
    <div>
      <nav className="nav">
        <div className="nav-inner">
          <div className="logo">
            portfolio<b>tracker</b>
          </div>
          <div className="nav-tabs">
            {TABS.map((tab) => (
              <NavLink
                key={tab.id}
                to={tab.id}
                end={tab.end}
                className={({ isActive }) => "nav-tab" + (isActive ? " active" : "")}
              >
                {t.nav[tab.labelKey]}
              </NavLink>
            ))}
          </div>
          <div className="nav-right">{user && <UserMenu />}</div>
        </div>
      </nav>

      <div className={"page" + (showFirstRun ? " blurred" : "")}>
        <Outlet />
      </div>

      {showFirstRun && <FirstRunOverlay />}
    </div>
  );
}
