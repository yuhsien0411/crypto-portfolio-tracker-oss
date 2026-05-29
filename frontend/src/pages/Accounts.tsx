import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ApiError, api } from "../api";
import { ChartPlaceholder, Delta, LineChart } from "../lib/charts";
import { fmt$, fmt$k } from "../lib/format";
import { useApi } from "../hooks/useApi";
import { SYNC_ALL_CONFIRM, SyncButton } from "../components/SyncButton";
import { EditAccountPanel } from "../components/EditAccountPanel";
import { NewGroupModal } from "../components/NewGroupModal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { AddCustomAssetsModal } from "../components/AddCustomAssetsModal";
import { useTranslation } from "../i18n/useTranslation";
import type {
  Account,
  AccountDetail,
  BalancePoint,
  Group,
  Holding,
} from "../types";

type FilterMode = "all" | "tok" | "pos";

type Selection =
  | { kind: "account"; id: string }
  | { kind: "group"; name: string };

function fmtAmount(n: number): string {
  if (!Number.isFinite(n)) return "";
  const abs = Math.abs(n);
  const maxFrac = abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8;
  return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
}

function fmtPriceStr(n: number): string {
  if (!Number.isFinite(n)) return "";
  const abs = Math.abs(n);
  const maxFrac = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return "$" + n.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
}

// Merge each member account's holdings into one combined list. Holdings line
// up by (kind, chain, proto, sym, name) so the same token held on the same
// chain via the same protocol rolls up; everything else stays a separate row.
// Per-account excluded keys are honored — they drop out of the aggregate the
// same way they drop out of the account's own balance.
function aggregateGroupHoldings(details: AccountDetail[]): Holding[] {
  const byKey = new Map<string, Holding>();
  for (const det of details) {
    const excluded = new Set(det.excluded_keys ?? []);
    for (const h of det.holdings) {
      if ((h.key && excluded.has(h.key)) || h.excluded) continue;
      const aggKey = `${h.kind}|${h.chain}|${h.proto}|${h.sym}|${h.name}`;
      const existing = byKey.get(aggKey);
      if (!existing) {
        byKey.set(aggKey, { ...h, key: null, excluded: false });
        continue;
      }
      const totalUsd = existing.usd + h.usd;
      const weightedD = (existing.d || 0) * existing.usd + (h.d || 0) * h.usd;
      existing.usd = totalUsd;
      existing.d = totalUsd !== 0 ? weightedD / totalUsd : 0;
      if (existing.amt_raw != null && h.amt_raw != null) {
        existing.amt_raw = existing.amt_raw + h.amt_raw;
        existing.amt = fmtAmount(existing.amt_raw);
        if (existing.amt_raw !== 0) {
          existing.price_raw = totalUsd / existing.amt_raw;
          existing.price = fmtPriceStr(existing.price_raw);
        } else {
          existing.price_raw = null;
          existing.price = "";
        }
      } else {
        // Mixed/unknown raw amounts (typical for DeFi positions) — keep usd
        // as the source of truth; blank amount/price cells.
        existing.amt_raw = null;
        existing.amt = "";
        existing.price_raw = null;
        existing.price = "";
      }
    }
  }
  return Array.from(byKey.values()).sort(
    (a, b) => Math.abs(b.usd) - Math.abs(a.usd),
  );
}

// Sum per-account balance histories into a single group series.
// Snapshots from different accounts rarely share timestamps, so we walk the
// merged timeline and carry each account's last-known balance forward — the
// chart then reflects the group's total at each observed point in time.
function aggregateGroupHistory(
  accountIds: string[],
  perAccount: Record<string, BalancePoint[]>,
): BalancePoint[] {
  if (accountIds.length === 0) return [];
  const series: Record<string, { t: number; v: number }[]> = {};
  const tsSet = new Set<number>();
  for (const id of accountIds) {
    const arr = (perAccount[id] ?? [])
      .map((p) => ({ t: new Date(p.t).getTime(), v: p.v }))
      .filter((p) => !Number.isNaN(p.t))
      .sort((a, b) => a.t - b.t);
    series[id] = arr;
    for (const p of arr) tsSet.add(p.t);
  }
  const tsList = Array.from(tsSet).sort((a, b) => a - b);
  if (tsList.length === 0) return [];
  const idxs: Record<string, number> = {};
  const last: Record<string, number> = {};
  for (const id of accountIds) {
    idxs[id] = 0;
    last[id] = 0;
  }
  const out: BalancePoint[] = [];
  for (const ts of tsList) {
    let sum = 0;
    for (const id of accountIds) {
      const arr = series[id];
      while (idxs[id] < arr.length && arr[idxs[id]].t <= ts) {
        last[id] = arr[idxs[id]].v;
        idxs[id]++;
      }
      sum += last[id];
    }
    out.push({ t: new Date(ts).toISOString(), v: sum });
  }
  return out;
}

const UNASSIGNED_FALLBACK: Group = {
  name: "Unassigned",
  bal: 0,
  d: 0,
  accounts: 0,
  color: "#8a8376",
};

const HIDE_THRESHOLD_USD = 1;

function HoldingIcon({ holding, size = 24 }: { holding: Holding; size?: number }) {
  const [failed, setFailed] = useState(false);
  const label = holding.sym.slice(0, 3) || "?";
  const showImg = holding.logo && !failed;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: holding.c,
        border: "1.5px solid var(--line)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--mono)",
        fontSize: Math.max(8, Math.round(size * 0.38)),
        color: "#fff",
        fontWeight: 600,
        overflow: "hidden",
      }}
    >
      {showImg ? (
        <img
          src={holding.logo!}
          alt={holding.sym}
          width={size}
          height={size}
          onError={() => setFailed(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        label
      )}
    </div>
  );
}

interface ProtocolGroup {
  proto: string;
  chain: string;
  logo?: string | null;
  color: string;
  usd: number;
  d: number;
  positions: Holding[];
}

function groupPositionsByProtocol(
  positions: Holding[],
  isExcluded: (p: Holding) => boolean,
): ProtocolGroup[] {
  const byProto = new Map<string, ProtocolGroup>();
  for (const p of positions) {
    const key = p.proto || "—";
    let bucket = byProto.get(key);
    if (!bucket) {
      bucket = {
        proto: key,
        chain: p.chain,
        logo: p.proto_logo || p.logo,
        color: p.c,
        usd: 0,
        d: 0,
        positions: [],
      };
      byProto.set(key, bucket);
    }
    bucket.positions.push(p);
    // Header totals reflect what actually counts toward account balance —
    // excluded rows are still listed below (greyed) but don't roll up.
    if (!isExcluded(p)) {
      bucket.usd += p.usd;
      bucket.d += (p.d || 0) * p.usd;
    }
  }
  const groups = Array.from(byProto.values()).map((g) => ({
    ...g,
    d: g.usd !== 0 ? g.d / g.usd : 0,
  }));
  groups.sort((a, b) => b.usd - a.usd);
  for (const g of groups) g.positions.sort((a, b) => b.usd - a.usd);
  return groups;
}

interface RowMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

function RowMenu({
  open,
  onOpen,
  onClose,
  items,
  title,
  inverted,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  items: RowMenuItem[];
  title: string;
  /** True when rendered on a dark/active row — flips trigger color. */
  inverted?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onClose]);

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (open) onClose();
          else onOpen();
        }}
        title={title}
        style={{
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: "0 4px",
          fontSize: 16,
          lineHeight: 1,
          color: inverted ? "rgba(245,241,232,0.8)" : "var(--ink-2)",
          fontFamily: "var(--mono)",
        }}
      >
        ⋯
      </button>
      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            zIndex: 30,
            marginTop: 4,
            background: "#fbfbfa",
            border: "1.5px solid var(--line)",
            borderRadius: 4,
            boxShadow: "4px 4px 0 rgba(26,24,20,0.12)",
            minWidth: 110,
            fontFamily: "var(--head)",
            fontSize: 12,
            color: "var(--ink)",
          }}
        >
          {items.map((it) => (
            <div
              key={it.label}
              onClick={(e) => {
                e.stopPropagation();
                onClose();
                it.onClick();
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "rgba(26,24,20,0.06)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
              style={{
                padding: "6px 12px",
                cursor: "pointer",
                color: it.danger ? "var(--accent)" : "var(--ink)",
                whiteSpace: "nowrap",
              }}
            >
              {it.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Accounts() {
  const navigate = useNavigate();
  const location = useLocation();
  const t = useTranslation();
  const accounts = useApi(() => api.listAccounts(), [], "accounts:list");
  const groups = useApi(() => api.listGroups(), [], "groups:list");
  const history = useApi(
    () => api.balanceHistory("ALL"),
    [],
    "balance:history:ALL",
  );
  const [selection, setSelection] = useState<Selection | null>(null);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [hideDust, setHideDust] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [expandedProtos, setExpandedProtos] = useState<Set<string>>(new Set());
  const [addAssetsOpen, setAddAssetsOpen] = useState(false);

  // Account list filters (mirrors what was on the old Manage page).
  const [query, setQuery] = useState("");
  const [srcFilter, setSrcFilter] = useState<string>("all");
  const [grpFilter, setGrpFilter] = useState<string>("all");

  // Edit-account panel state — used by both "+ Add account" and the per-row
  // "..." menu's Edit action.
  const [accountPanel, setAccountPanel] = useState<
    { mode: "new" } | { mode: "edit"; account: Account } | null
  >(null);
  // Group modal state — used by "+ Add group" and the per-row Edit action.
  const [groupModal, setGroupModal] = useState<
    { mode: "new" } | { mode: "edit"; group: Group } | null
  >(null);
  // Pending account deletion — confirmed via ConfirmDialog.
  const [deleteAccount, setDeleteAccount] = useState<Account | null>(null);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Hover + open-menu tracking so the "..." button is only visible on hover
  // (or while its dropdown is open, so it stays clickable).
  const [hoverGroup, setHoverGroup] = useState<string | null>(null);
  const [hoverAccount, setHoverAccount] = useState<string | null>(null);
  const [openGroupMenu, setOpenGroupMenu] = useState<string | null>(null);
  const [openAccountMenu, setOpenAccountMenu] = useState<string | null>(null);

  // Local override of the server's excluded_keys list while a PATCH is
  // in-flight. ``id`` scopes the override so switching accounts mid-flight
  // doesn't apply stale state to the new account.
  const [optimisticExcluded, setOptimisticExcluded] = useState<
    { id: string; keys: string[] } | null
  >(null);
  const [busyExclusion, setBusyExclusion] = useState(false);

  // First-run overlay sends users here with state.openAdd to auto-open
  // the Add Account panel; wipe state so refresh doesn't re-trigger it.
  useEffect(() => {
    const state = location.state as { openAdd?: boolean } | null;
    if (state?.openAdd) {
      setAccountPanel({ mode: "new" });
      navigate(location.pathname, { replace: true, state: {} });
    }
  }, [location.state, location.pathname, navigate]);

  const all = accounts.data ?? [];
  const gs = groups.data ?? [];
  // Default to the first account when nothing is explicitly selected so the
  // page lands on something useful — same as before adding group selection.
  const effectiveSelection: Selection | null =
    selection ?? (all[0] ? { kind: "account", id: all[0].id } : null);
  const activeAccountId =
    effectiveSelection?.kind === "account" ? effectiveSelection.id : null;
  const activeGroupName =
    effectiveSelection?.kind === "group" ? effectiveSelection.name : null;
  const detail = useApi(
    () => (activeAccountId ? api.getAccount(activeAccountId) : Promise.resolve(null)),
    [activeAccountId],
    activeAccountId ? `account:${activeAccountId}` : undefined,
  );

  const filteredAccounts = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((a) => {
      if (q && !a.name.toLowerCase().includes(q) && !a.addr.toLowerCase().includes(q))
        return false;
      if (srcFilter !== "all" && a.source !== srcFilter) return false;
      if (grpFilter !== "all" && a.group !== grpFilter) return false;
      return true;
    });
  }, [all, query, srcFilter, grpFilter]);

  // Group accounts by their `group` field (lowercase key). Keep the order
  // from the groups API (user-defined), then append any groups that only
  // exist on accounts (e.g. stale) and finally the Unassigned bucket last.
  const grouped = useMemo(() => {
    const byKey = new Map<string, Account[]>();
    for (const a of filteredAccounts) {
      const key = (a.group || "unassigned").toLowerCase();
      const list = byKey.get(key) ?? [];
      list.push(a);
      byKey.set(key, list);
    }

    const seen = new Set<string>();
    const ordered: { group: Group; accounts: Account[] }[] = [];
    for (const g of gs) {
      const key = g.name.toLowerCase();
      const list = byKey.get(key);
      if (list && list.length > 0) {
        ordered.push({ group: g, accounts: list });
        seen.add(key);
      }
    }
    for (const [key, list] of byKey) {
      if (seen.has(key)) continue;
      const label =
        key === "unassigned"
          ? UNASSIGNED_FALLBACK
          : { ...UNASSIGNED_FALLBACK, name: key.charAt(0).toUpperCase() + key.slice(1) };
      ordered.push({ group: label, accounts: list });
    }
    return ordered;
  }, [filteredAccounts, gs]);

  const toggleGroup = (name: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  const toggleProto = (name: string) => {
    setExpandedProtos((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const activeGroupMembers = useMemo(() => {
    if (!activeGroupName) return null;
    const entry = grouped.find((g) => g.group.name === activeGroupName);
    return entry?.accounts ?? null;
  }, [activeGroupName, grouped]);
  const activeGroupIdsKey =
    activeGroupMembers?.map((m) => m.id).join(",") ?? "";

  const groupDetails = useApi<AccountDetail[] | null>(
    () => {
      if (!activeGroupName || !activeGroupMembers || activeGroupMembers.length === 0)
        return Promise.resolve(null);
      return Promise.all(activeGroupMembers.map((m) => api.getAccount(m.id)));
    },
    [activeGroupName, activeGroupIdsKey],
    activeGroupName
      ? `group:${activeGroupName}:details:${activeGroupIdsKey}`
      : undefined,
  );

  const activeGroup = useMemo(() => {
    if (!activeGroupName) return null;
    const entry = grouped.find((g) => g.group.name === activeGroupName);
    if (!entry) return null;
    const members = entry.accounts;
    const bal = members.reduce((acc, m) => acc + (m.bal || 0), 0);
    // Value-weighted 24h %: each account's % weighted by its USD balance,
    // matching how a single account's `d` represents change against its bal.
    const weighted = members.reduce(
      (acc, m) => acc + (m.bal || 0) * (m.d || 0),
      0,
    );
    const d = bal !== 0 ? weighted / bal : 0;
    const dUsd = weighted / 100;
    const series = aggregateGroupHistory(
      members.map((m) => m.id),
      history.data?.per_account ?? {},
    );
    return { group: entry.group, members, bal, d, dUsd, series };
  }, [activeGroupName, grouped, history.data]);

  const groupHoldings = useMemo<Holding[]>(
    () =>
      activeGroup && groupDetails.data
        ? aggregateGroupHoldings(groupDetails.data)
        : [],
    [activeGroup, groupDetails.data],
  );

  const holdings: Holding[] = activeGroup
    ? groupHoldings
    : detail.data?.holdings ?? [];
  const serverExcluded = detail.data?.excluded_keys ?? [];
  const excludedKeys =
    optimisticExcluded && optimisticExcluded.id === activeAccountId
      ? optimisticExcluded.keys
      : serverExcluded;
  const excludedSet = useMemo(() => new Set(excludedKeys), [excludedKeys]);
  // Per-asset exclusion is account-scoped — in group view, excluded rows are
  // already filtered out during aggregation, so nothing reads as "excluded"
  // here.
  const isExcluded = (h: Holding): boolean => {
    if (activeGroup) return false;
    return h.key ? excludedSet.has(h.key) : !!h.excluded;
  };
  const visibleHoldings = hideDust
    ? holdings.filter(
        (h) => Math.abs(h.usd) >= HIDE_THRESHOLD_USD || isExcluded(h),
      )
    : holdings;
  const tokens = visibleHoldings.filter((h) => h.kind === "tok");
  const positions = visibleHoldings.filter((h) => h.kind === "pos");
  const tokCount = tokens.length;
  const posCount = positions.length;
  const protoGroups = useMemo(
    () => groupPositionsByProtocol(positions, isExcluded),
    [positions, excludedSet],
  );

  const toggleExcluded = async (h: Holding) => {
    if (!detail.data || !h.key || busyExclusion) return;
    const next = new Set(excludedKeys);
    if (next.has(h.key)) next.delete(h.key);
    else next.add(h.key);
    const nextList = Array.from(next).sort();
    const accountId = detail.data.id;
    setOptimisticExcluded({ id: accountId, keys: nextList });
    setBusyExclusion(true);
    try {
      await api.setExcludedKeys(accountId, nextList);
      accounts.refetch();
      detail.refetch();
      history.refetch();
    } catch (err) {
      // Roll back optimistic state so the UI re-syncs with the server.
      setOptimisticExcluded(null);
      // eslint-disable-next-line no-console
      console.error("Failed to update excluded assets", err);
    } finally {
      setBusyExclusion(false);
    }
  };

  const excludedRowStyle = (excluded: boolean) =>
    excluded
      ? ({
          opacity: 0.45,
          color: "var(--muted)",
        } as const)
      : undefined;
  const excludedUsdStyle = (excluded: boolean) =>
    excluded ? ({ textDecoration: "line-through" } as const) : undefined;

  const refreshAfterSync = () => {
    accounts.refetch();
    detail.refetch();
    history.refetch();
    groupDetails.refetch();
  };

  const refreshAfterAccountChange = () => {
    accounts.refetch();
    groups.refetch();
    history.refetch();
    groupDetails.refetch();
  };

  const onConfirmDeleteAccount = async () => {
    if (!deleteAccount) return;
    setDeleting(true);
    setDeleteErr(null);
    try {
      await api.deleteAccount(deleteAccount.id);
      // If the deleted account was the active one, fall back to the first
      // remaining account on next render.
      if (activeAccountId === deleteAccount.id) setSelection(null);
      setDeleteAccount(null);
      refreshAfterAccountChange();
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : t.accounts.deleteFailed;
      setDeleteErr(msg);
    } finally {
      setDeleting(false);
    }
  };

  const showTokens = filter === "all" || filter === "tok";
  const showPositions = filter === "all" || filter === "pos";

  return (
    <div className="sheet">
      <div className="sheet-head">
        <div>
          <h2>{t.accounts.title}</h2>
        </div>
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          <SyncButton
            sync={() => api.syncAll()}
            onDone={refreshAfterSync}
            label={t.accounts.syncAll}
            confirm={SYNC_ALL_CONFIRM}
          />
        </div>
      </div>

      {all.length === 0 ? (
        <div className="sketch-box p-16 tiny muted">{t.accounts.empty}</div>
      ) : (
        <div className="col" style={{ gap: 12 }}>
          <div className="row wrap" style={{ gap: 8, alignItems: "center" }}>
            <input
              className="winput"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.accounts.searchPlaceholder}
              style={{ width: 220 }}
            />
            <select
              className="winput"
              style={{ width: 160 }}
              value={srcFilter}
              onChange={(e) => setSrcFilter(e.target.value)}
            >
              <option value="all">{t.accounts.sourceAll}</option>
              <option value="onchain">{t.accounts.sourceOnchain}</option>
              <option value="exchange">{t.accounts.sourceExchange}</option>
              <option value="custom">{t.accounts.sourceCustom}</option>
            </select>
            <select
              className="winput"
              style={{ width: 160 }}
              value={grpFilter}
              onChange={(e) => setGrpFilter(e.target.value)}
            >
              <option value="all">{t.accounts.groupAll}</option>
              {gs.map((g) => (
                <option key={g.name} value={g.name.toLowerCase()}>
                  {g.name}
                </option>
              ))}
            </select>
            {(query !== "" || srcFilter !== "all" || grpFilter !== "all") && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setSrcFilter("all");
                  setGrpFilter("all");
                }}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  padding: "0 6px",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontFamily: "var(--head)",
                  fontSize: 12,
                  color: "var(--ink-2)",
                }}
              >
                <span aria-hidden="true">✕</span>
                {t.accounts.clearFilters}
              </button>
            )}
          </div>

          <div className="grid" style={{ gridTemplateColumns: "300px 1fr", gap: 12 }}>
            <div className="sketch-box p-12">
              <div className="row between mb-8" style={{ gap: 6 }}>
                <span className="mono-xs">
                  {t.accounts.treeTitle} <span className="tiny">({all.length})</span>
                </span>
                <div className="row" style={{ gap: 4 }}>
                  <button
                    className="wbtn"
                    onClick={() => setGroupModal({ mode: "new" })}
                    title={t.accounts.addGroupTitle}
                    style={{ padding: "2px 8px", fontSize: 11 }}
                  >
                    {t.accounts.addGroup}
                  </button>
                  <button
                    className="wbtn primary"
                    onClick={() => setAccountPanel({ mode: "new" })}
                    title={t.accounts.addAccountTitle}
                    style={{ padding: "2px 8px", fontSize: 11 }}
                  >
                    {t.accounts.addAccount}
                  </button>
                </div>
              </div>
              <div
                className="col"
                style={{ gap: 3, fontFamily: "var(--mono)", fontSize: 12 }}
              >
                {grouped.map(({ group, accounts: members }) => {
                  const collapsed = collapsedGroups.has(group.name);
                  const groupTotal = members.reduce(
                    (acc, m) => acc + (m.bal || 0),
                    0,
                  );
                  const isUnassigned = group.name.toLowerCase() === "unassigned";
                  const groupKey = group.name;
                  const groupHovered = hoverGroup === groupKey;
                  const groupMenuOpen = openGroupMenu === groupKey;
                  const showGroupActions =
                    !isUnassigned && (groupHovered || groupMenuOpen);
                  const isGroupActive = activeGroupName === group.name;
                  return (
                    <div key={group.name} className="col" style={{ gap: 2 }}>
                      <div
                        onClick={() => {
                          setSelection({ kind: "group", name: group.name });
                          // Expand on select so the user sees the accounts the
                          // aggregate is rolling up — but don't toggle, since
                          // the chevron handles collapse explicitly.
                          if (collapsed) toggleGroup(group.name);
                        }}
                        onMouseEnter={() => setHoverGroup(groupKey)}
                        onMouseLeave={() => setHoverGroup((cur) => (cur === groupKey ? null : cur))}
                        className="row between"
                        style={{
                          padding: "4px 6px",
                          background: isGroupActive
                            ? "var(--ink)"
                            : "rgba(26,24,20,0.05)",
                          color: isGroupActive ? "var(--paper)" : "inherit",
                          borderRadius: 4,
                          gap: 6,
                          alignItems: "center",
                          cursor: "pointer",
                          userSelect: "none",
                        }}
                      >
                        <span
                          className="row"
                          style={{ gap: 6, alignItems: "center", minWidth: 0 }}
                        >
                          <span
                            style={{
                              display: "inline-block",
                              width: 8,
                              height: 8,
                              background: group.color,
                              borderRadius: 2,
                              flexShrink: 0,
                            }}
                          />
                          <span
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleGroup(group.name);
                            }}
                            title={collapsed ? t.accounts.expandGroup : t.accounts.collapseGroup}
                            style={{
                              width: 10,
                              display: "inline-block",
                              cursor: "pointer",
                            }}
                          >
                            {collapsed ? "▸" : "▾"}
                          </span>
                          <span
                            style={{ overflow: "hidden", textOverflow: "ellipsis" }}
                          >
                            {group.name}{" "}
                            <span className="tiny">({members.length})</span>
                          </span>
                        </span>
                        <span
                          className="row"
                          style={{ gap: 4, alignItems: "center", minWidth: 60, justifyContent: "flex-end" }}
                        >
                          {showGroupActions ? (
                            <RowMenu
                              open={groupMenuOpen}
                              onOpen={() => setOpenGroupMenu(groupKey)}
                              onClose={() => setOpenGroupMenu(null)}
                              title={t.accounts.rowMenuTitle}
                              inverted={isGroupActive}
                              items={[
                                {
                                  label: t.accounts.menuEdit,
                                  onClick: () =>
                                    setGroupModal({ mode: "edit", group }),
                                },
                                {
                                  label: t.accounts.menuDelete,
                                  danger: true,
                                  onClick: () =>
                                    setGroupModal({ mode: "edit", group }),
                                },
                              ]}
                            />
                          ) : (
                            <span
                              className="tiny"
                              style={{
                                color: isGroupActive
                                  ? "rgba(245,241,232,0.7)"
                                  : "var(--muted)",
                              }}
                            >
                              {fmt$k(groupTotal)}
                            </span>
                          )}
                        </span>
                      </div>
                      {!collapsed &&
                        members.map((a) => {
                          const isActive = a.id === activeAccountId;
                          const accountHovered = hoverAccount === a.id;
                          const accountMenuOpen = openAccountMenu === a.id;
                          const showAccountActions =
                            accountHovered || accountMenuOpen;
                          return (
                            <div
                              key={a.id}
                              onClick={() =>
                                setSelection({ kind: "account", id: a.id })
                              }
                              onMouseEnter={() => setHoverAccount(a.id)}
                              onMouseLeave={() =>
                                setHoverAccount((cur) => (cur === a.id ? null : cur))
                              }
                              className={
                                "row between account-row" + (isActive ? " active" : "")
                              }
                              style={{
                                padding: "4px 8px 4px 22px",
                                borderRadius: 4,
                                cursor: "pointer",
                                background: isActive ? "var(--ink)" : "transparent",
                                color: isActive ? "var(--paper)" : "inherit",
                              }}
                            >
                              <span
                                style={{
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {a.name}
                              </span>
                              <span
                                className="row"
                                style={{
                                  gap: 4,
                                  alignItems: "center",
                                  minWidth: 60,
                                  justifyContent: "flex-end",
                                }}
                              >
                                {showAccountActions ? (
                                  <RowMenu
                                    open={accountMenuOpen}
                                    onOpen={() => setOpenAccountMenu(a.id)}
                                    onClose={() => setOpenAccountMenu(null)}
                                    title={t.accounts.rowMenuTitle}
                                    inverted={isActive}
                                    items={[
                                      {
                                        label: t.accounts.menuEdit,
                                        onClick: () =>
                                          setAccountPanel({
                                            mode: "edit",
                                            account: a,
                                          }),
                                      },
                                      {
                                        label: t.accounts.menuDelete,
                                        danger: true,
                                        onClick: () => {
                                          setDeleteErr(null);
                                          setDeleteAccount(a);
                                        },
                                      },
                                    ]}
                                  />
                                ) : (
                                  <span
                                    className="tiny"
                                    style={{
                                      color: isActive
                                        ? "rgba(245,241,232,0.7)"
                                        : "var(--muted)",
                                    }}
                                  >
                                    {fmt$k(a.bal)}
                                  </span>
                                )}
                              </span>
                            </div>
                          );
                        })}
                    </div>
                  );
                })}
                {filteredAccounts.length === 0 && (
                  <div className="tiny muted" style={{ padding: 8 }}>
                    {t.accounts.noAccountsFilter}
                  </div>
                )}
              </div>
            </div>

            <div className="col" style={{ gap: 12 }}>
              <div className="sketch-box p-16">
                {activeGroup ? (
                  <>
                    <div className="row between">
                      <div>
                        <span
                          className="src"
                          style={{
                            borderColor: activeGroup.group.color,
                            color: activeGroup.group.color,
                          }}
                        >
                          {t.accounts.groupTag}
                        </span>
                        <div
                          className="row"
                          style={{ gap: 10, alignItems: "center", marginTop: 4 }}
                        >
                          <div className="head" style={{ fontSize: 28 }}>
                            {activeGroup.group.name}
                          </div>
                        </div>
                        <div className="tiny" style={{ fontFamily: "var(--mono)" }}>
                          {t.accounts.groupMembers(activeGroup.members.length)}
                        </div>
                      </div>
                      <div
                        className="col"
                        style={{ alignItems: "flex-end", gap: 4 }}
                      >
                        <div className="head" style={{ fontSize: 32 }}>
                          {fmt$(activeGroup.bal)}
                        </div>
                        <div
                          className="row"
                          style={{ gap: 8, alignItems: "center" }}
                        >
                          <span
                            className={
                              activeGroup.dUsd >= 0 ? "accent-2" : "accent"
                            }
                            style={{ fontFamily: "var(--mono)", fontSize: 12 }}
                          >
                            {(activeGroup.dUsd >= 0 ? "+" : "−") +
                              fmt$(Math.abs(activeGroup.dUsd))}
                          </span>
                          <Delta v={activeGroup.d} />
                        </div>
                      </div>
                    </div>
                    <div style={{ height: 140, marginTop: 10 }}>
                      {activeGroup.series.length >= 1 ? (
                        <LineChart
                          seed={11}
                          fill="#2e8b6b"
                          series={activeGroup.series}
                        />
                      ) : (
                        <ChartPlaceholder />
                      )}
                    </div>
                  </>
                ) : detail.data ? (
                  <>
                    <div className="row between">
                      <div>
                        <span className={"src " + detail.data.source}>
                          {detail.data.source}
                        </span>
                        <div
                          className="row"
                          style={{ gap: 10, alignItems: "center", marginTop: 4 }}
                        >
                          <div className="head" style={{ fontSize: 28 }}>
                            {detail.data.name}
                          </div>
                          <SyncButton
                            sync={() => api.syncAccount(detail.data!.id)}
                            onDone={refreshAfterSync}
                            label={t.accounts.syncBtn}
                            hideStatus={detail.data.source !== "custom"}
                          />
                          <button
                            className="wbtn"
                            onClick={() => setAddAssetsOpen(true)}
                            title={t.accounts.manageAssetsTitle}
                          >
                            {t.accounts.manageAssets}
                          </button>
                        </div>
                        <div className="tiny" style={{ fontFamily: "var(--mono)" }}>
                          {detail.data.addr}
                          {detail.data.chain && <> · {detail.data.chain}</>} ·{" "}
                          {detail.data.group}
                        </div>
                        {detail.data.note && (
                          <div
                            className="tiny"
                            style={{
                              marginTop: 6,
                              color: "var(--ink-2)",
                              whiteSpace: "pre-wrap",
                              maxWidth: 520,
                            }}
                          >
                            {detail.data.note}
                          </div>
                        )}
                      </div>
                      <div
                        className="col"
                        style={{ alignItems: "flex-end", gap: 4 }}
                      >
                        <div className="head" style={{ fontSize: 32 }}>
                          {fmt$(detail.data.bal)}
                        </div>
                        <Delta v={detail.data.d} />
                        {detail.data.synced_at && (
                          <span className="tiny" style={{ color: "var(--muted)" }}>
                            {t.accounts.syncedAt(
                              new Date(detail.data.synced_at).toLocaleString(),
                            )}
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ height: 100, marginTop: 10 }}>
                      {(history.data?.per_account[detail.data.id]?.length ?? 0) >= 1 ? (
                        <LineChart
                          seed={11}
                          fill="#2e8b6b"
                          series={history.data!.per_account[detail.data.id]}
                        />
                      ) : (
                        <ChartPlaceholder />
                      )}
                    </div>
                  </>
                ) : (
                  <div className="tiny muted">{t.accounts.selectAccount}</div>
                )}
              </div>

              {(activeGroup || detail.data) && (
              <div className="sketch-box p-16">
                <div className="row between mb-8">
                  <div className="row" style={{ gap: 8, alignItems: "center" }}>
                    <span className="mono-xs">{t.accounts.holdingsTitle}</span>
                  </div>
                  <div className="row" style={{ gap: 10, alignItems: "center" }}>
                    <label
                      className="tiny"
                      style={{
                        display: "inline-flex",
                        gap: 4,
                        alignItems: "center",
                        cursor: "pointer",
                        userSelect: "none",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={hideDust}
                        onChange={(e) => setHideDust(e.target.checked)}
                      />
                      {t.accounts.hideDust}
                    </label>
                    <div className="row" style={{ gap: 6 }}>
                      <span
                        className={"pill" + (filter === "all" ? " active" : "")}
                        onClick={() => setFilter("all")}
                      >
                        {t.accounts.filterAll} ({tokCount + posCount})
                      </span>
                      <span
                        className={"pill" + (filter === "tok" ? " active" : "")}
                        onClick={() => setFilter("tok")}
                      >
                        {t.accounts.filterTokens} ({tokCount})
                      </span>
                      <span
                        className={"pill" + (filter === "pos" ? " active" : "")}
                        onClick={() => setFilter("pos")}
                      >
                        {t.accounts.filterDefi} ({protoGroups.length})
                      </span>
                    </div>
                  </div>
                </div>
                {activeGroup && groupDetails.loading && holdings.length === 0 ? (
                  <div className="tiny muted" style={{ padding: "12px 0" }}>
                    {t.accounts.loadingGroupAssets}
                  </div>
                ) : holdings.length === 0 ? (
                  <div className="tiny muted" style={{ padding: "12px 0" }}>
                    {t.accounts.noHoldings}
                  </div>
                ) : visibleHoldings.length === 0 ? (
                  <div className="tiny muted" style={{ padding: "12px 0" }}>
                    {t.accounts.allDust}
                  </div>
                ) : (
                  <table className="sk">
                    <thead>
                      <tr>
                        <th style={{ width: 36 }}></th>
                        <th>{t.accounts.colAssetPosition}</th>
                        <th>{t.accounts.colProtocol}</th>
                        <th>{t.accounts.colChainEx}</th>
                        <th className="num">{t.accounts.colAmount}</th>
                        <th className="num">{t.accounts.colPrice}</th>
                        <th className="num">{t.accounts.colUsdValue}</th>
                        <th className="num">{t.accounts.col24h}</th>
                        <th style={{ width: 28 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {showTokens &&
                        tokens.map((r, i) => {
                          const ex = isExcluded(r);
                          return (
                            <tr key={`tok-${i}`} style={excludedRowStyle(ex)}>
                              <td>
                                <HoldingIcon holding={r} />
                              </td>
                              <td>
                                <b>{r.sym}</b>{" "}
                                <span style={{ color: "var(--muted)" }}>{r.name}</span>
                                {ex && (
                                  <span
                                    className="tiny"
                                    style={{
                                      marginLeft: 6,
                                      padding: "0 5px",
                                      border: "1px solid var(--line)",
                                      borderRadius: 3,
                                      color: "var(--ink-2)",
                                      fontSize: 9,
                                      letterSpacing: 0.4,
                                      verticalAlign: "middle",
                                    }}
                                  >
                                    {t.accounts.excludedTag}
                                  </span>
                                )}
                              </td>
                              <td>{r.proto}</td>
                              <td>
                                <span
                                  className="src chain"
                                  style={{
                                    borderColor: "var(--line)",
                                    color: "var(--ink-2)",
                                  }}
                                >
                                  {r.chain}
                                </span>
                              </td>
                              <td className="num">{r.amt}</td>
                              <td className="num">
                                {r.price}
                                {r.price_source === "api" && (
                                  <span
                                    className="tiny"
                                    title={t.accounts.livePriceTip}
                                    style={{
                                      marginLeft: 6,
                                      padding: "0 5px",
                                      border: "1px solid var(--line)",
                                      borderRadius: 3,
                                      color: "var(--ink-2)",
                                      fontSize: 9,
                                      letterSpacing: 0.4,
                                      verticalAlign: "middle",
                                    }}
                                  >
                                    {t.accounts.live}
                                  </span>
                                )}
                              </td>
                              <td className="num">
                                <b style={excludedUsdStyle(ex)}>
                                  {r.usd < 0 ? "−" : ""}
                                  {fmt$(Math.abs(r.usd))}
                                </b>
                              </td>
                              <td className="num">
                                <Delta v={r.d} />
                              </td>
                              <td className="num">
                                {!activeGroup && (
                                  <button
                                    type="button"
                                    onClick={() => toggleExcluded(r)}
                                    disabled={busyExclusion || !r.key}
                                    title={
                                      ex
                                        ? t.accounts.includeTip
                                        : t.accounts.excludeTip
                                    }
                                    style={{
                                      background: "transparent",
                                      border: "1px solid var(--line)",
                                      borderRadius: 3,
                                      cursor: busyExclusion ? "wait" : "pointer",
                                      fontSize: 9,
                                      padding: "1px 5px",
                                      letterSpacing: 0.4,
                                      textTransform: "uppercase",
                                      opacity: busyExclusion ? 0.5 : 1,
                                      color: "var(--ink-2)",
                                    }}
                                  >
                                    {ex ? t.accounts.includeBtn : t.accounts.excludeBtn}
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      {showPositions &&
                        protoGroups.map((g) => {
                          const expanded = expandedProtos.has(g.proto);
                          const headerHolding: Holding = {
                            kind: "pos",
                            sym: g.proto,
                            name: g.proto,
                            proto: g.proto,
                            chain: g.chain,
                            amt: "",
                            price: "",
                            usd: g.usd,
                            d: g.d,
                            c: g.color,
                            logo: g.logo,
                          };
                          return (
                            <Fragment key={`proto-${g.proto}`}>
                              <tr
                                onClick={() => toggleProto(g.proto)}
                                style={{ cursor: "pointer" }}
                              >
                                <td>
                                  <HoldingIcon holding={headerHolding} />
                                </td>
                                <td>
                                  <span
                                    style={{
                                      display: "inline-block",
                                      width: 12,
                                      fontFamily: "var(--mono)",
                                    }}
                                  >
                                    {expanded ? "▾" : "▸"}
                                  </span>
                                  <b>{g.proto}</b>{" "}
                                  <span className="chip" style={{ marginLeft: 6 }}>
                                    {t.accounts.positionsLabel(g.positions.length)}
                                  </span>
                                </td>
                                <td>{g.proto}</td>
                                <td>
                                  <span
                                    className="src chain"
                                    style={{
                                      borderColor: "var(--line)",
                                      color: "var(--ink-2)",
                                    }}
                                  >
                                    {g.chain}
                                  </span>
                                </td>
                                <td className="num">—</td>
                                <td className="num">—</td>
                                <td className="num">
                                  <b>
                                    {g.usd < 0 ? "−" : ""}
                                    {fmt$(Math.abs(g.usd))}
                                  </b>
                                </td>
                                <td className="num">
                                  <Delta v={g.d} />
                                </td>
                                <td></td>
                              </tr>
                              {expanded &&
                                g.positions.map((r, i) => {
                                  const ex = isExcluded(r);
                                  return (
                                    <tr
                                      key={`pos-${g.proto}-${i}`}
                                      style={excludedRowStyle(ex)}
                                    >
                                      <td style={{ paddingLeft: 16 }}>
                                        <HoldingIcon holding={r} size={20} />
                                      </td>
                                      <td style={{ paddingLeft: 24 }}>
                                        <b>{r.name}</b>
                                        {ex && (
                                          <span
                                            className="tiny"
                                            style={{
                                              marginLeft: 6,
                                              padding: "0 5px",
                                              border: "1px solid var(--line)",
                                              borderRadius: 3,
                                              color: "var(--ink-2)",
                                              fontSize: 9,
                                              letterSpacing: 0.4,
                                              verticalAlign: "middle",
                                            }}
                                          >
                                            {t.accounts.excludedTag}
                                          </span>
                                        )}
                                      </td>
                                      <td>{r.proto}</td>
                                      <td>
                                        <span
                                          className="src chain"
                                          style={{
                                            borderColor: "var(--line)",
                                            color: "var(--ink-2)",
                                          }}
                                        >
                                          {r.chain}
                                        </span>
                                      </td>
                                      <td className="num">{r.amt}</td>
                                      <td className="num">{r.price}</td>
                                      <td className="num">
                                        <b style={excludedUsdStyle(ex)}>
                                          {r.usd < 0 ? "−" : ""}
                                          {fmt$(Math.abs(r.usd))}
                                        </b>
                                      </td>
                                      <td className="num">
                                        <Delta v={r.d} />
                                      </td>
                                      <td className="num">
                                        {!activeGroup && (
                                          <button
                                            type="button"
                                            onClick={() => toggleExcluded(r)}
                                            disabled={busyExclusion || !r.key}
                                            title={
                                              ex
                                                ? t.accounts.includeTip
                                                : t.accounts.excludeTip
                                            }
                                            style={{
                                              background: "transparent",
                                              border: "1px solid var(--line)",
                                              borderRadius: 3,
                                              cursor: busyExclusion ? "wait" : "pointer",
                                              fontSize: 9,
                                              padding: "1px 5px",
                                              letterSpacing: 0.4,
                                              textTransform: "uppercase",
                                              opacity: busyExclusion ? 0.5 : 1,
                                              color: "var(--ink-2)",
                                            }}
                                          >
                                            {ex
                                              ? t.accounts.includeBtn
                                              : t.accounts.excludeBtn}
                                          </button>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                            </Fragment>
                          );
                        })}
                    </tbody>
                  </table>
                )}
              </div>
              )}
            </div>
          </div>
        </div>
      )}

      {accountPanel && (
        <EditAccountPanel
          account={accountPanel.mode === "edit" ? accountPanel.account : null}
          isNew={accountPanel.mode === "new"}
          groups={gs}
          onClose={() => setAccountPanel(null)}
          onSaved={(saved) => {
            setAccountPanel(null);
            if (accountPanel.mode === "new")
              setSelection({ kind: "account", id: saved.id });
            refreshAfterAccountChange();
            detail.refetch();
          }}
          onDeleted={() => {
            const wasEditing =
              accountPanel.mode === "edit" ? accountPanel.account.id : null;
            setAccountPanel(null);
            if (wasEditing && activeAccountId === wasEditing) setSelection(null);
            refreshAfterAccountChange();
          }}
          onGroupsChanged={() => groups.refetch()}
        />
      )}

      {groupModal && (
        <NewGroupModal
          editing={groupModal.mode === "edit" ? groupModal.group : undefined}
          onClose={() => setGroupModal(null)}
          onCreated={() => {
            // Rename also moves account.group_name on the backend, so the
            // accounts list needs a refetch too.
            accounts.refetch();
            groups.refetch();
          }}
          onDeleted={() => groups.refetch()}
        />
      )}

      {addAssetsOpen && detail.data && (
        <AddCustomAssetsModal
          account={detail.data}
          onClose={() => setAddAssetsOpen(false)}
          onSaved={() => {
            setAddAssetsOpen(false);
            accounts.refetch();
            detail.refetch();
            history.refetch();
          }}
        />
      )}

      <ConfirmDialog
        open={deleteAccount !== null}
        title={t.accounts.deleteAccountTitle}
        message={
          <>
            {t.accounts.deleteAccountConfirmPrefix}
            <b>“{deleteAccount?.name}”</b>
            {t.accounts.deleteAccountConfirmSuffix}
            {deleteErr && (
              <div
                className="tiny"
                style={{ marginTop: 8, color: "var(--accent)" }}
              >
                {deleteErr}
              </div>
            )}
          </>
        }
        confirmLabel={deleting ? t.common.loading : t.common.delete}
        cancelLabel={t.common.cancel}
        danger
        onCancel={() => {
          if (deleting) return;
          setDeleteAccount(null);
          setDeleteErr(null);
        }}
        onConfirm={onConfirmDeleteAccount}
      />
    </div>
  );
}
