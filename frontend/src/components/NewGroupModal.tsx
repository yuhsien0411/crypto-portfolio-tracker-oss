import { useRef, useState } from "react";
import { ApiError, api } from "../api";
import { useTranslation } from "../i18n/useTranslation";
import type { Group } from "../types";
import { ConfirmDialog } from "./ConfirmDialog";

const PRESET_COLORS = [
  "#1a1814",
  "#d64933",
  "#2e8b6b",
  "#7a5fbd",
  "#f2c14e",
  "#8a8376",
];

export function NewGroupModal({
  onClose,
  onCreated,
  onDeleted,
  editing,
  zIndex = 50,
}: {
  onClose: () => void;
  onCreated: (group: Group) => void;
  /** Required in edit mode — fired after a successful delete. */
  onDeleted?: () => void;
  /** When provided, the modal edits this group instead of creating a new one. */
  editing?: Group;
  /** Override when stacking above another modal (e.g. the Add Account panel uses z=60). */
  zIndex?: number;
}) {
  const t = useTranslation();
  const isEdit = editing !== undefined;
  const [name, setName] = useState(editing?.name ?? "");
  const [color, setColor] = useState(editing?.color ?? PRESET_COLORS[2]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const customColorRef = useRef<HTMLInputElement>(null);
  const isPreset = PRESET_COLORS.includes(color);

  const onDeleteClick = () => {
    if (!editing) return;
    if (editing.accounts > 0) {
      setErr(t.manage.deleteGroupCannot(editing.name, editing.accounts));
      return;
    }
    setErr(null);
    setConfirmDelete(true);
  };

  const doDelete = async () => {
    if (!editing) return;
    setBusy(true);
    setErr(null);
    try {
      await api.deleteGroup(editing.name.toLowerCase());
      setConfirmDelete(false);
      onDeleted?.();
      onClose();
    } catch (e) {
      setConfirmDelete(false);
      if (e instanceof ApiError) setErr(e.message);
      else setErr(e instanceof Error ? e.message : t.common.failed);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setErr(t.newGroup.nameRequired);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const result = isEdit
        ? await api.updateGroup(editing!.name.toLowerCase(), {
            name: trimmed,
            color,
          })
        : await api.createGroup(trimmed, color);
      onCreated(result);
      onClose();
    } catch (e) {
      if (e instanceof ApiError) setErr(e.message);
      else setErr(e instanceof Error ? e.message : t.common.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex,
        background: "rgba(26,24,20,0.35)",
        backdropFilter: "blur(2px)",
        WebkitBackdropFilter: "blur(2px)",
        overflowY: "auto",
        display: "flex",
        justifyContent: "center",
        padding: "40px 20px",
      }}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="sketch-box thick p-16"
        style={{
          width: "100%",
          maxWidth: 380,
          margin: "auto",
          background: "#fbfbfa",
          boxShadow: "10px 10px 0 rgba(26,24,20,0.12)",
        }}
      >
        <div className="row between mb-12">
          <span className="head" style={{ fontSize: 20 }}>
            {isEdit ? t.newGroup.editTitle : t.newGroup.title}
          </span>
          <span
            onClick={onClose}
            style={{ cursor: "pointer", fontSize: 18, color: "var(--muted)" }}
          >
            ✕
          </span>
        </div>

        <div className="mono-xs mb-8">{t.newGroup.name}</div>
        <input
          className="winput"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t.newGroup.namePlaceholder}
          style={{ marginBottom: 14 }}
        />

        <div className="mono-xs mb-8">{t.newGroup.color}</div>
        <div
          className="row wrap"
          style={{ gap: 8, marginBottom: 14, alignItems: "center" }}
        >
          {PRESET_COLORS.map((c) => (
            <span
              key={c}
              onClick={() => setColor(c)}
              style={{
                display: "inline-block",
                width: 28,
                height: 28,
                background: c,
                borderRadius: 4,
                border:
                  c === color
                    ? "2.5px solid var(--accent)"
                    : "1.5px solid var(--line)",
                cursor: "pointer",
              }}
            />
          ))}
          <span
            onClick={() => customColorRef.current?.click()}
            title={t.newGroup.customColor}
            style={{
              position: "relative",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              background: isPreset
                ? "conic-gradient(#d64933, #f2c14e, #2e8b6b, #7a5fbd, #d64933)"
                : color,
              borderRadius: 4,
              border:
                !isPreset
                  ? "2.5px solid var(--accent)"
                  : "1.5px solid var(--line)",
              cursor: "pointer",
              color: "#fbfbfa",
              fontSize: 16,
              lineHeight: 1,
              textShadow: "0 0 2px rgba(0,0,0,0.6)",
            }}
          >
            {isPreset ? "+" : ""}
            <input
              ref={customColorRef}
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                opacity: 0,
                cursor: "pointer",
                padding: 0,
                border: 0,
              }}
            />
          </span>
        </div>

        {err && (
          <div
            className="tiny"
            style={{ marginBottom: 10, color: "var(--accent)" }}
          >
            {err}
          </div>
        )}

        <div className="row between" style={{ gap: 6, alignItems: "center" }}>
          {isEdit ? (
            <button
              type="button"
              className="wbtn accent"
              onClick={onDeleteClick}
              disabled={busy}
              title={t.manage.deleteGroupTitle}
            >
              {t.manage.deleteGroupConfirmLabel}
            </button>
          ) : (
            <span />
          )}
          <div className="row" style={{ gap: 6 }}>
            <button
              type="button"
              className="wbtn"
              onClick={onClose}
              disabled={busy}
            >
              {t.newGroup.cancel}
            </button>
            <button
              type="submit"
              className="wbtn primary"
              disabled={busy || !name.trim()}
            >
              {isEdit ? t.newGroup.save : t.newGroup.create}
            </button>
          </div>
        </div>
      </form>

      <ConfirmDialog
        open={confirmDelete}
        title={t.manage.deleteGroupConfirmTitle}
        message={
          <>
            {t.manage.deleteGroupConfirmPrefix}
            <b>“{editing?.name}”</b>
            {t.manage.deleteGroupConfirmSuffix}
          </>
        }
        confirmLabel={t.manage.deleteGroupConfirmLabel}
        cancelLabel={t.common.cancel}
        danger
        onCancel={() => setConfirmDelete(false)}
        onConfirm={doDelete}
      />
    </div>
  );
}
