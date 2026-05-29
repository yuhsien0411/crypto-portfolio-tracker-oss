import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  danger = false,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}) {
  // Close on Escape when open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open || typeof document === "undefined") return null;

  const dialog = (
    <div
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        backgroundColor: "rgba(26,24,20,0.55)",
        backdropFilter: "blur(8px) saturate(80%)",
        WebkitBackdropFilter: "blur(8px) saturate(80%)",
        overflowY: "auto",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        padding: "40px 20px",
        fontFamily: "var(--head)",
        // Force its own stacking context, independent of whatever ancestor
        // we rendered in before the portal.
        isolation: "isolate",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 420,
          margin: "auto",
          backgroundColor: "#fbfbfa",
          border: "2.5px solid var(--line)",
          borderRadius: 6,
          padding: 16,
          boxShadow: "10px 10px 0 rgba(26,24,20,0.25)",
          fontFamily: "var(--head)",
          color: "var(--ink)",
          position: "relative",
          zIndex: 1,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 12,
          }}
        >
          <span
            id="confirm-dialog-title"
            style={{
              fontFamily: "var(--head)",
              fontWeight: 500,
              fontSize: 18,
              letterSpacing: "-0.015em",
            }}
          >
            {title}
          </span>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              fontSize: 18,
              color: "var(--muted)",
              padding: 4,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>
        <div
          style={{
            marginBottom: 16,
            fontFamily: "var(--head)",
            fontSize: 14,
            lineHeight: 1.55,
            letterSpacing: "-0.005em",
            color: "var(--ink-2)",
          }}
        >
          {message}
        </div>
        <div
          style={{
            display: "flex",
            gap: 6,
            justifyContent: "flex-end",
          }}
        >
          <button type="button" className="wbtn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={"wbtn " + (danger ? "accent" : "primary")}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
