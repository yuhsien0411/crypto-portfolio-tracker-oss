import { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { ApiError } from "../api";
import { useAuth } from "../auth/AuthContext";
import { useTranslation } from "../i18n/useTranslation";

type Mode = "login" | "signup";

export function Auth() {
  const { status } = useAuth();
  const location = useLocation();
  const initialMode: Mode = location.pathname === "/signup" ? "signup" : "login";
  const [mode, setMode] = useState<Mode>(initialMode);

  useEffect(() => {
    setMode(location.pathname === "/signup" ? "signup" : "login");
  }, [location.pathname]);

  if (status === "authed") {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="landing auth-shell">
      <div className="nav">
        <div className="nav-inner">
          <div className="logo">
            portfolio<b>tracker</b>
          </div>
        </div>
      </div>

      <div className="auth-wrap">
        <AuthPanel mode={mode} onModeChange={setMode} />
      </div>
    </div>
  );
}

function AuthPanel({
  mode,
  onModeChange,
}: {
  mode: Mode;
  onModeChange: (m: Mode) => void;
}) {
  const { login, signup } = useAuth();
  const navigate = useNavigate();
  const t = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!email.trim() || !password) {
      setErr(t.auth.errEmailPwRequired);
      return;
    }
    if (mode === "signup") {
      if (password.length < 8) {
        setErr(t.auth.errPwTooShort);
        return;
      }
      if (password !== confirm) {
        setErr(t.auth.errPwMismatch);
        return;
      }
    }
    setBusy(true);
    try {
      if (mode === "signup") {
        await signup(email.trim(), password);
      } else {
        await login(email.trim(), password);
      }
      navigate("/", { replace: true });
    } catch (e) {
      if (e instanceof ApiError) {
        setErr(e.message);
      } else {
        setErr(e instanceof Error ? e.message : t.common.failed);
      }
    } finally {
      setBusy(false);
    }
  };

  const switchTo = (m: Mode) => {
    onModeChange(m);
    setErr(null);
    navigate(m === "signup" ? "/signup" : "/login", { replace: true });
  };

  return (
    <div className="auth-card">
      <div className="section-eyebrow" style={{ marginBottom: 6 }}>
        {mode === "signup" ? t.auth.eyebrowSignup : t.auth.eyebrowLogin}
      </div>
      <h2 className="h2" style={{ fontSize: 32, maxWidth: "none", marginBottom: 18 }}>
        {mode === "signup" ? t.auth.titleSignup : t.auth.titleLogin}
      </h2>

      <div className="auth-tabs">
        <button
          type="button"
          className={"auth-tab" + (mode === "login" ? " active" : "")}
          onClick={() => switchTo("login")}
        >
          {t.auth.tabLogin}
        </button>
        <button
          type="button"
          className={"auth-tab" + (mode === "signup" ? " active" : "")}
          onClick={() => switchTo("signup")}
        >
          {t.auth.tabSignup}
        </button>
      </div>

      <form onSubmit={submit} className="col" style={{ gap: 14 }}>
        <label className="col" style={{ gap: 6 }}>
          <span className="mono-xs">{t.auth.email}</span>
          <input
            className="winput auth-input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t.auth.placeholderEmail}
            required
          />
        </label>
        <label className="col" style={{ gap: 6 }}>
          <span className="mono-xs">{t.auth.password}</span>
          <input
            className="winput auth-input"
            type="password"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={
              mode === "signup"
                ? t.auth.placeholderPasswordSignup
                : t.auth.placeholderPasswordLogin
            }
            required
          />
        </label>
        {mode === "signup" && (
          <label className="col" style={{ gap: 6 }}>
            <span className="mono-xs">{t.auth.confirmPassword}</span>
            <input
              className="winput auth-input"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={t.auth.placeholderPasswordConfirm}
              required
            />
          </label>
        )}

        {err && (
          <div className="tiny accent" style={{ fontFamily: "var(--mono)" }}>
            {err}
          </div>
        )}

        <button
          type="submit"
          className="btn btn-primary btn-lg"
          disabled={busy}
          style={{ marginTop: 6 }}
        >
          {busy
            ? mode === "signup"
              ? t.auth.creatingAccount
              : t.auth.signingIn
            : mode === "signup"
              ? t.auth.createAccount
              : t.auth.logIn}
        </button>
      </form>

      {mode === "signup" && (
        <div
          className="tiny"
          style={{ color: "var(--muted)", textAlign: "center", marginTop: 16 }}
        >
          {t.auth.footerSignup}
        </div>
      )}
    </div>
  );
}
