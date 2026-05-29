import { useState, type ReactNode } from "react";
import { api } from "../api";
import { useAuth } from "../auth/AuthContext";
import { useTranslation } from "../i18n/useTranslation";
import type { TranslationDict } from "../i18n/en";
import type { SyncEstimate, SyncResult, SyncSummary } from "../types";
import { ConfirmDialog } from "./ConfirmDialog";

/** Sentinel marker that asks the SyncButton to render the localized
 *  "sync every account" confirmation. We use a marker (instead of a literal
 *  message at module scope) so the message picks up the current language. */
export const SYNC_ALL_CONFIRM = { kind: "syncAll" as const };

type Result = SyncSummary | SyncResult;

interface Props {
  /**
   * Called on click. Should hit the backend sync endpoint and resolve with the
   * result. The button handles loading state + status display.
   */
  sync: () => Promise<Result>;
  /** Called after a successful sync so the caller can refetch page data. */
  onDone?: (result: Result) => void;
  /** Short label shown on the button. Defaults to the localized "Sync now". */
  label?: string;
  /** Style variant — headline buttons live in `.sheet-head`, inline ones sit
   * next to a per-account detail. */
  variant?: "primary" | "ghost";
  className?: string;
  /** When provided, a confirm dialog pops up before firing `sync`. Either pass
   *  the SYNC_ALL_CONFIRM marker (uses localized strings) or a fully custom
   *  config. */
  confirm?:
    | typeof SYNC_ALL_CONFIRM
    | {
        title?: string;
        message: ReactNode;
        confirmLabel?: string;
      };
  /** Hide the inline status text ("synced · $…") shown next to the button.
   *  Useful when the surrounding UI already renders the synced balance. */
  hideStatus?: boolean;
}

function summarize(r: Result, t: TranslationDict): string {
  if ("results" in r) {
    const parts: string[] = [];
    if (r.ok_count) parts.push(t.syncBtn.okCount(r.ok_count));
    if (r.skipped_count) parts.push(t.syncBtn.skippedCount(r.skipped_count));
    if (r.error_count) parts.push(t.syncBtn.errorCount(r.error_count));
    return parts.join(" · ") || t.syncBtn.noAccounts;
  }
  if (r.status === "ok") {
    return r.balance != null
      ? t.syncBtn.syncedDollar(r.balance.toLocaleString())
      : t.syncBtn.statusSynced;
  }
  if (r.status === "skipped") return t.syncBtn.skipped(r.message ?? "");
  return t.syncBtn.error(r.message ?? "");
}

export function SyncButton({
  sync,
  onDone,
  label,
  variant = "primary",
  className,
  confirm,
  hideStatus = false,
}: Props) {
  const { refresh } = useAuth();
  const t = useTranslation();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [ok, setOk] = useState<boolean | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [estimate, setEstimate] = useState<SyncEstimate | null>(null);
  const buttonLabel = label ?? t.syncBtn.syncNow;
  const isSyncAllConfirm = !!confirm && "kind" in confirm;

  const doSync = async () => {
    if (busy) return;
    setBusy(true);
    setStatus(t.syncBtn.statusSyncing);
    setOk(null);
    try {
      const result = await sync();
      setStatus(summarize(result, t));
      const failed =
        "results" in result ? result.error_count > 0 : result.status === "error";
      setOk(!failed);
      onDone?.(result);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : t.syncBtn.failed);
      setOk(false);
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const handleClick = () => {
    if (busy) return;
    if (confirm) {
      setConfirmOpen(true);
      // Refetch on every open so the breakdown reflects the user's current
      // accounts (they may have added/removed one since the last open).
      if (isSyncAllConfirm) {
        setEstimate(null);
        api.syncAllEstimate().then(setEstimate).catch(() => {
          // Estimate is informational; if it fails we still let the user
          // confirm using the static fallback message.
        });
      }
      return;
    }
    void doSync();
  };

  // Resolve the sentinel marker to a localized config at render time.
  const resolvedConfirm = (() => {
    if (!confirm) return null;
    if ("kind" in confirm) {
      return {
        title: t.syncBtn.syncAllTitle,
        message: (
          <>
            {t.syncBtn.syncAllMsg1}
            <b>{t.syncBtn.syncAllMsgBold}</b>
            {t.syncBtn.syncAllMsg2}
            <div style={{ marginTop: 10 }}>
              {estimate === null ? (
                <span className="tiny" style={{ color: "var(--muted)" }}>
                  {t.syncBtn.syncAllEstimateLoading}
                </span>
              ) : (
                <span className="tiny" style={{ color: "var(--muted)" }}>
                  {t.syncBtn.syncAllEstimateAccounts(estimate.accounts_count)}
                </span>
              )}
            </div>
          </>
        ),
        confirmLabel: t.syncBtn.syncAllConfirm,
      };
    }
    return {
      title: confirm.title ?? t.syncBtn.confirmSync,
      message: confirm.message,
      confirmLabel: confirm.confirmLabel ?? t.syncBtn.sync,
    };
  })();

  return (
    <>
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        {status && !hideStatus && (
          <span
            className="tiny"
            style={{
              color: ok === false ? "var(--accent)" : "var(--muted)",
              fontFamily: "var(--mono)",
              maxWidth: 260,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={status}
          >
            {status}
          </span>
        )}
        <button
          type="button"
          onClick={handleClick}
          disabled={busy}
          className={["wbtn", variant === "primary" ? "primary" : "", className]
            .filter(Boolean)
            .join(" ")}
        >
          {busy ? t.syncBtn.syncing : `↻ ${buttonLabel}`}
        </button>
      </div>

      {resolvedConfirm && (
        <ConfirmDialog
          open={confirmOpen}
          title={resolvedConfirm.title}
          message={resolvedConfirm.message}
          confirmLabel={resolvedConfirm.confirmLabel}
          cancelLabel={t.common.cancel}
          onConfirm={() => {
            setConfirmOpen(false);
            void doSync();
          }}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </>
  );
}
