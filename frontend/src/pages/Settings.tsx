import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, api } from "../api";
import { useAuth } from "../auth/AuthContext";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useApi } from "../hooks/useApi";
import { usePreferences } from "../hooks/usePreferences";
import { useTranslation } from "../i18n/useTranslation";
import type { AutoSyncSettings } from "../types";

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return "request failed";
}

export function Settings() {
  const { user } = useAuth();
  const t = useTranslation();

  return (
    <div className="sheet">
      <div className="sheet-head">
        <div>
          <h2>{t.settings.title}</h2>
          <div className="tiny mt-8">
            {user?.email ?? ""}{t.settings.subtitle}
          </div>
        </div>
      </div>

      <div className="col" style={{ gap: 24 }}>
        <section className="col" style={{ gap: 10 }}>
          <h3 style={{ margin: 0 }}>{t.settings.sectionPreferences}</h3>
          <PreferencesSection />
        </section>

        <section className="col" style={{ gap: 10 }}>
          <h3 style={{ margin: 0 }}>{t.settings.sectionAutoSync}</h3>
          <AutoSyncSection />
        </section>

        <section className="col" style={{ gap: 10 }}>
          <h3 style={{ margin: 0 }}>{t.settings.sectionDanger}</h3>
          <DangerSection />
        </section>
      </div>
    </div>
  );
}

// ── Preferences ──────────────────────────────────────────────────────────

function PreferencesSection() {
  const { prefs, setPref } = usePreferences();
  const t = useTranslation();
  return (
    <div
      className="sketch-box p-12"
      style={{ maxWidth: 640, display: "flex", flexDirection: "column", gap: 10 }}
    >
      <div className="mono-xs">{t.settings.display}</div>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          cursor: "pointer",
        }}
      >
        <span>
          <div style={{ fontFamily: "var(--head)", fontSize: 14 }}>
            {t.settings.hideLowBalance}
          </div>
          <div className="tiny muted">
            {t.settings.hideLowBalanceDesc}
          </div>
        </span>
        <input
          type="checkbox"
          checked={prefs.hideLowBalance}
          onChange={(e) => setPref("hideLowBalance", e.target.checked)}
          style={{ cursor: "pointer" }}
        />
      </label>
    </div>
  );
}

// ── Auto sync ───────────────────────────────────────────────────────────

const UTC_OFFSETS = [
  "UTC-12:00",
  "UTC-11:00",
  "UTC-10:00",
  "UTC-09:30",
  "UTC-09:00",
  "UTC-08:00",
  "UTC-07:00",
  "UTC-06:00",
  "UTC-05:00",
  "UTC-04:00",
  "UTC-03:30",
  "UTC-03:00",
  "UTC-02:00",
  "UTC-01:00",
  "UTC",
  "UTC+01:00",
  "UTC+02:00",
  "UTC+03:00",
  "UTC+03:30",
  "UTC+04:00",
  "UTC+04:30",
  "UTC+05:00",
  "UTC+05:30",
  "UTC+05:45",
  "UTC+06:00",
  "UTC+06:30",
  "UTC+07:00",
  "UTC+08:00",
  "UTC+08:45",
  "UTC+09:00",
  "UTC+09:30",
  "UTC+10:00",
  "UTC+10:30",
  "UTC+11:00",
  "UTC+12:00",
  "UTC+12:45",
  "UTC+13:00",
  "UTC+13:45",
  "UTC+14:00",
];

function formatUtcOffset(totalMinutes: number): string {
  if (totalMinutes === 0) return "UTC";
  const sign = totalMinutes > 0 ? "+" : "-";
  const total = Math.abs(totalMinutes);
  return `UTC${sign}${String(Math.floor(total / 60)).padStart(2, "0")}:${String(
    total % 60,
  ).padStart(2, "0")}`;
}

function browserUtcOffset(): string {
  try {
    return formatUtcOffset(-new Date().getTimezoneOffset());
  } catch {
    return "UTC";
  }
}

function normalizeOffset(value: string | null | undefined): string {
  const raw = (value || "").trim().replace(/\s+/g, "");
  if (/^UTC$/i.test(raw)) return "UTC";
  const match = raw.match(/^UTC([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!match) return browserUtcOffset();
  const [, sign, hourRaw, minuteRaw] = match;
  return `UTC${sign}${hourRaw.padStart(2, "0")}:${minuteRaw ?? "00"}`;
}

function fmtStatus(data: AutoSyncSettings, t: ReturnType<typeof useTranslation>): string {
  if (!data.enabled) return t.settings.autoSyncOff;
  if (data.next_run_at) return t.settings.autoSyncNext(fmtDate(data.next_run_at));
  return t.settings.autoSyncNoRun;
}

function AutoSyncSection() {
  const t = useTranslation();
  const settings = useApi(
    () => api.autoSyncSettings(),
    [],
    "auto-sync:settings",
  );
  const [enabled, setEnabled] = useState(false);
  const [localTime, setLocalTime] = useState("09:00");
  const [timezone, setTimezone] = useState(browserUtcOffset());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!settings.data) return;
    setEnabled(settings.data.enabled);
    setLocalTime(settings.data.local_time || "09:00");
    setTimezone(
      settings.data.enabled || settings.data.last_run_at
        ? normalizeOffset(settings.data.timezone)
        : browserUtcOffset(),
    );
  }, [settings.data]);

  const handleSave = async () => {
    setSaving(true);
    setErr(null);
    setSaved(false);
    try {
      await api.setAutoSyncSettings({
        enabled,
        local_time: localTime,
        timezone: timezone.trim(),
      });
      settings.refetch();
      setSaved(true);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  if (settings.loading && !settings.data) {
    return <div className="tiny muted">{t.settings.loadingAutoSync}</div>;
  }
  if (settings.error && !settings.data) {
    return (
      <div className="tiny accent">
        {t.settings.failedAutoSync(errMsg(settings.error))}
      </div>
    );
  }

  return (
    <div
      className="sketch-box p-12"
      style={{ maxWidth: 640, display: "flex", flexDirection: "column", gap: 12 }}
    >
      <div className="mono-xs">{t.settings.autoSyncDaily}</div>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          cursor: "pointer",
        }}
      >
        <span>
          <div style={{ fontFamily: "var(--head)", fontSize: 14 }}>
            {t.settings.autoSyncEnable}
          </div>
          <div className="tiny muted">{t.settings.autoSyncDesc}</div>
        </span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          style={{ cursor: "pointer" }}
        />
      </label>

      <div className="grid g-2" style={{ gap: 10 }}>
        <label className="col" style={{ gap: 4 }}>
          <span className="mono-xs">{t.settings.autoSyncTime}</span>
          <input
            className="winput"
            type="time"
            value={localTime}
            onChange={(e) => setLocalTime(e.target.value)}
          />
        </label>
        <label className="col" style={{ gap: 4 }}>
          <span className="mono-xs">{t.settings.autoSyncTimezone}</span>
          <select
            className="winput"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          >
            {[...new Set([timezone, browserUtcOffset(), ...UTC_OFFSETS])].map((tz) => (
              <option value={tz} key={tz}>
                {tz}
              </option>
            ))}
          </select>
        </label>
      </div>

      {settings.data && (
        <div className="tiny muted" style={{ lineHeight: 1.5 }}>
          <div>{fmtStatus(settings.data, t)}</div>
          {settings.data.last_run_at && (
            <div>{t.settings.autoSyncLast(fmtDate(settings.data.last_run_at))}</div>
          )}
          {settings.data.last_status && (
            <div>{t.settings.autoSyncLastStatus(settings.data.last_status)}</div>
          )}
          {settings.data.last_error && (
            <div className="accent">{t.settings.autoSyncLastError(settings.data.last_error)}</div>
          )}
        </div>
      )}

      <div className="row wrap">
        <button
          type="button"
          className="wbtn primary"
          onClick={() => void handleSave()}
          disabled={saving}
        >
          {saving ? t.settings.savingAutoSync : t.settings.saveAutoSync}
        </button>
        {saved && <span className="tiny accent-2">{t.settings.autoSyncSaved}</span>}
        {err && <span className="tiny accent">{err}</span>}
      </div>
    </div>
  );
}

// ── Danger zone ──────────────────────────────────────────────────────────

function DangerSection() {
  const { deleteAccount } = useAuth();
  const navigate = useNavigate();
  const t = useTranslation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleDelete = async () => {
    setDeleting(true);
    setErr(null);
    try {
      await deleteAccount();
      setConfirmOpen(false);
      navigate("/login", { replace: true });
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className="sketch-box p-12"
      style={{ maxWidth: 640, borderColor: "var(--accent)" }}
    >
      <div className="mono-xs" style={{ color: "var(--accent)" }}>
        {t.settings.deleteAccount}
      </div>
      <p className="tiny" style={{ marginTop: 8, lineHeight: 1.5 }}>
        {t.settings.deleteDesc1}
        <b>{t.settings.deleteDescBold}</b>
        {t.settings.deleteDesc2}
      </p>
      <button
        type="button"
        className="wbtn accent"
        onClick={() => {
          setErr(null);
          setConfirmOpen(true);
        }}
        style={{ marginTop: 10 }}
      >
        {t.settings.deleteBtn}
      </button>

      <ConfirmDialog
        open={confirmOpen}
        title={t.settings.deleteConfirmTitle}
        danger
        confirmLabel={deleting ? t.settings.deleting : t.settings.deleteYes}
        cancelLabel={t.settings.deleteCancel}
        message={
          <>
            {t.settings.deleteConfirmMsg1}
            <b>{t.settings.deleteConfirmMsgBold}</b>
            {t.settings.deleteConfirmMsg2}
            {err && (
              <div
                className="tiny accent"
                style={{ marginTop: 10, fontFamily: "var(--mono)" }}
              >
                {err}
              </div>
            )}
          </>
        }
        onConfirm={() => void handleDelete()}
        onCancel={() => {
          if (!deleting) setConfirmOpen(false);
        }}
      />
    </div>
  );
}
