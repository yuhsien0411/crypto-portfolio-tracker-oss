import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { usePreferences } from "../hooks/usePreferences";
import { useTranslation } from "../i18n/useTranslation";

const LANGS = [
  { code: "EN", label: "English" },
  { code: "ZH", label: "中文" },
];

type Panel = "main" | "lang";

export function UserMenu() {
  const { user, logout } = useAuth();
  const { prefs, setPref } = usePreferences();
  const t = useTranslation();
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>("main");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setPanel("main");
  }, [open]);

  if (!user) return null;

  const currentLang =
    LANGS.find((l) => l.code === prefs.lang)?.code ?? "EN";

  const handleLogout = async () => {
    setOpen(false);
    await logout();
    navigate("/login", { replace: true });
  };

  const handleSettings = () => {
    setOpen(false);
    navigate("/settings");
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <div
        className={"nav-tab" + (open ? " active" : "")}
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontFamily: "var(--mono)",
          fontSize: 12,
        }}
        title={user.email}
      >
        <span>{user.email}</span>
        <span style={{ fontSize: 10, opacity: 0.6 }}>▾</span>
      </div>

      {open && (
        <div
          className="sketch-box"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            background: "#fbfbfa",
            zIndex: 50,
            minWidth: 260,
            padding: 6,
            boxShadow: "2px 3px 0 rgba(26,24,20,0.08)",
          }}
        >
          {panel === "main" && (
            <MainPanel
              email={user.email}
              currentLang={currentLang}
              languageLabel={t.userMenu.language}
              settingsLabel={t.userMenu.settings}
              logoutLabel={t.userMenu.logout}
              onLang={() => setPanel("lang")}
              onSettings={handleSettings}
              onLogout={() => void handleLogout()}
            />
          )}
          {panel === "lang" && (
            <LangPanel
              current={currentLang}
              title={t.userMenu.language}
              onBack={() => setPanel("main")}
              onPick={(code) => {
                setPref("lang", code);
                setPanel("main");
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  padding: "8px 10px",
  borderRadius: 6,
  cursor: "pointer",
  fontFamily: "var(--head)",
  fontSize: 13,
  userSelect: "none",
};

function hoverIn(e: React.MouseEvent<HTMLDivElement>) {
  (e.currentTarget as HTMLDivElement).style.background = "rgba(26,24,20,0.05)";
}
function hoverOut(e: React.MouseEvent<HTMLDivElement>) {
  (e.currentTarget as HTMLDivElement).style.background = "transparent";
}

function Divider() {
  return (
    <div
      style={{
        height: 1,
        background: "var(--line, rgba(26,24,20,0.1))",
        margin: "4px 2px",
      }}
    />
  );
}

function MainPanel(props: {
  email: string;
  currentLang: string;
  languageLabel: string;
  settingsLabel: string;
  logoutLabel: string;
  onLang: () => void;
  onSettings: () => void;
  onLogout: () => void;
}) {
  return (
    <div>
      <div
        style={{
          padding: "8px 10px 6px",
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--muted)",
          lineHeight: 1.3,
        }}
      >
        <div style={{ color: "var(--ink)", fontSize: 12 }}>{props.email}</div>
      </div>
      <Divider />
      <div style={rowStyle} onMouseEnter={hoverIn} onMouseLeave={hoverOut} onClick={props.onLang}>
        <span>🌐 {props.languageLabel}</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)" }}>
          {props.currentLang} ▸
        </span>
      </div>
      <div style={rowStyle} onMouseEnter={hoverIn} onMouseLeave={hoverOut} onClick={props.onSettings}>
        <span>⚙ {props.settingsLabel}</span>
        <span style={{ fontSize: 11, color: "var(--muted)" }}>›</span>
      </div>
      <Divider />
      <div style={rowStyle} onMouseEnter={hoverIn} onMouseLeave={hoverOut} onClick={props.onLogout}>
        <span>{props.logoutLabel}</span>
      </div>
    </div>
  );
}

function LangPanel(props: {
  current: string;
  title: string;
  onBack: () => void;
  onPick: (code: string) => void;
}) {
  return (
    <div>
      <BackHeader title={props.title} onBack={props.onBack} />
      <div style={{ maxHeight: 280, overflowY: "auto" }}>
        {LANGS.map((l) => {
          const active = l.code === props.current;
          return (
            <div
              key={l.code}
              style={{
                ...rowStyle,
                background: active ? "rgba(242,193,78,0.2)" : "transparent",
              }}
              onMouseEnter={(e) => {
                if (!active) hoverIn(e);
              }}
              onMouseLeave={(e) => {
                if (!active) hoverOut(e);
              }}
              onClick={() => props.onPick(l.code)}
            >
              <span>{l.label}</span>
              <span
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 10,
                  color: "var(--muted)",
                }}
              >
                {l.code}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BackHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 8px",
        cursor: "pointer",
        fontFamily: "var(--head)",
        fontSize: 13,
        fontWeight: 600,
        borderRadius: 6,
      }}
      onClick={onBack}
      onMouseEnter={hoverIn}
      onMouseLeave={hoverOut}
    >
      <span style={{ fontSize: 12, color: "var(--muted)" }}>‹</span>
      <span>{title}</span>
    </div>
  );
}
