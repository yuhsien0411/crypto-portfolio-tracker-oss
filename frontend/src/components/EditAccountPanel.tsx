import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { ApiError, api } from "../api";
import { useAuth } from "../auth/AuthContext";
import { fmt$ } from "../lib/format";
import { useTranslation } from "../i18n/useTranslation";
import type { TranslationDict } from "../i18n/en";
import type {
  Account,
  AccountInput,
  CexCredentialInput,
  CexCredentialStatus,
  CustomAssetInput,
  Group,
  PriceSource,
  SourceType,
} from "../types";
import { NewGroupModal } from "./NewGroupModal";

// ── Account type taxonomy ───────────────────────────────────────────────

type OnchainKind = "evm" | "solana" | "sui" | "cosmos";

type CredField = "api_key" | "api_secret" | "passphrase" | "wallet_address";

interface ExchangeDef {
  id: string;
  label: string;
  fields: CredField[];
}

const EXCHANGES: ExchangeDef[] = [
  { id: "binance", label: "Binance", fields: ["api_key", "api_secret"] },
  { id: "gate", label: "Gate", fields: ["api_key", "api_secret"] },
  { id: "bitget", label: "Bitget", fields: ["api_key", "api_secret", "passphrase"] },
  { id: "bybit", label: "Bybit", fields: ["api_key", "api_secret"] },
  { id: "okx", label: "OKX", fields: ["api_key", "api_secret", "passphrase"] },
  { id: "extended", label: "Extended", fields: ["api_key"] },
  { id: "hyperliquid", label: "Hyperliquid", fields: ["wallet_address"] },
  { id: "derive", label: "Derive", fields: ["wallet_address", "api_secret"] },
];

const FIELD_LABELS: Record<CredField, string> = {
  api_key: "API key",
  api_secret: "API secret",
  passphrase: "Passphrase",
  wallet_address: "Wallet address",
};

function fieldLabel(t: TranslationDict, f: CredField): string {
  switch (f) {
    case "api_key": return t.editAcct.fieldApiKey;
    case "api_secret": return t.editAcct.fieldApiSecret;
    case "passphrase": return t.editAcct.fieldPassphrase;
    case "wallet_address": return t.editAcct.fieldWalletAddress;
  }
}

const FIELD_IS_SECRET: Record<CredField, boolean> = {
  api_key: false,
  api_secret: true,
  passphrase: true,
  wallet_address: false,
};

type CustomAssetRow = {
  symbol: string;
  amount: string;
  unit_price: string;
  price_source: PriceSource;
};
const EMPTY_ASSET_ROW: CustomAssetRow = {
  symbol: "",
  amount: "",
  unit_price: "",
  price_source: "custom",
};

function deriveOnchainKind(chain: string | null | undefined): OnchainKind {
  const c = (chain ?? "").toLowerCase();
  if (c === "solana") return "solana";
  if (c === "sui") return "sui";
  if (c === "cosmos") return "cosmos";
  return "evm";
}

function chainLabelForKind(kind: OnchainKind): string {
  if (kind === "solana") return "Solana";
  if (kind === "sui") return "Sui";
  if (kind === "cosmos") return "Cosmos";
  return "EVM";
}

function deriveExchangeId(a: Account | null): string {
  if (!a) return EXCHANGES[0].id;
  const addrKey = (a.addr || "").toLowerCase();
  const match = EXCHANGES.find((e) => e.id === addrKey);
  return match ? match.id : EXCHANGES[0].id;
}

// ── Component ───────────────────────────────────────────────────────────

export function EditAccountPanel({
  account,
  isNew,
  groups,
  onClose,
  onSaved,
  onDeleted,
  onGroupsChanged,
}: {
  account: Account | null;
  isNew: boolean;
  groups: Group[];
  onClose: () => void;
  onSaved: (a: Account) => void;
  onDeleted: (id: string) => void;
  /** Called after the inline "+ New group" flow creates a group, so the
   *  parent can refetch its `groups` prop. */
  onGroupsChanged?: () => void;
}) {
  const { refresh: refreshAuth } = useAuth();
  const t = useTranslation();
  // Shared fields
  const [accountType, setAccountType] = useState<SourceType>(
    account?.source ?? "onchain",
  );
  const [name, setName] = useState(account?.name ?? "");
  const [group, setGroup] = useState(account?.group ?? "unassigned");
  const [note, setNote] = useState(account?.note ?? "");

  // Onchain
  const [onchainKind, setOnchainKind] = useState<OnchainKind>(
    deriveOnchainKind(account?.chain),
  );
  const [walletAddress, setWalletAddress] = useState(
    account?.source === "onchain" ? (account?.addr ?? "") : "",
  );

  // Exchange
  const [exchangeId, setExchangeId] = useState(deriveExchangeId(account));
  const [credValues, setCredValues] = useState<Record<CredField, string>>({
    api_key: "",
    api_secret: "",
    passphrase: "",
    wallet_address: "",
  });
  const [existingCred, setExistingCred] = useState<CexCredentialStatus | null>(
    null,
  );

  // Custom — user-entered assets; one blank row to start so there's always
  // something visible to fill in.
  const [customAssets, setCustomAssets] = useState<CustomAssetRow[]>([
    { ...EMPTY_ASSET_ROW },
  ]);

  const [busy, setBusy] = useState(false);
  const [busyStage, setBusyStage] = useState<null | "saving" | "syncing">(null);
  const [err, setErr] = useState<string | null>(null);
  const [groupModalOpen, setGroupModalOpen] = useState(false);

  // Load existing credentials status when editing an exchange account, so we
  // can render "(saved — replace)" placeholders on the creds inputs.
  useEffect(() => {
    if (isNew || accountType !== "exchange" || !account?.id) return;
    let cancelled = false;
    api
      .credentialsStatus()
      .then((res) => {
        if (cancelled) return;
        const match = res.cex.find((c) => c.account_id === account.id);
        if (match) setExistingCred(match);
      })
      .catch(() => {
        /* ignore — inputs just show blank placeholders */
      });
    return () => {
      cancelled = true;
    };
  }, [isNew, accountType, account?.id]);

  const currentExchange =
    EXCHANGES.find((e) => e.id === exchangeId) ?? EXCHANGES[0];

  const patchCred = (field: CredField, value: string) =>
    setCredValues((c) => ({ ...c, [field]: value }));

  // Filter out blank custom asset rows and parse into API shape. A row
  // counts as filled when at least one of its three inputs has a value.
  function collectCustomAssets(): {
    clean: CustomAssetInput[];
    invalid: number;
  } {
    let invalid = 0;
    const clean: CustomAssetInput[] = [];
    for (const row of customAssets) {
      const sym = row.symbol.trim();
      const amt = row.amount.trim();
      const price = row.unit_price.trim();
      if (!sym && !amt && !price) continue;
      const amountNum = Number(amt);
      const priceNum = Number(price);
      if (!sym || !Number.isFinite(amountNum) || !Number.isFinite(priceNum)) {
        invalid += 1;
        continue;
      }
      clean.push({
        symbol: sym.toUpperCase(),
        amount: amountNum,
        unit_price: priceNum,
        price_source: row.price_source,
      });
    }
    return { clean, invalid };
  }

  async function save() {
    setErr(null);
    if (!name.trim()) {
      setErr(t.editAcct.nameRequired);
      return;
    }
    if (accountType === "onchain" && !walletAddress.trim()) {
      setErr(t.editAcct.addrRequired);
      return;
    }
    if (accountType === "exchange" && isNew) {
      const required = currentExchange.fields;
      const missing = required.filter((f) => !credValues[f].trim());
      if (missing.length > 0) {
        setErr(
          t.editAcct.missingCred(
            missing.length > 1 ? "s" : "",
            missing.map((f) => fieldLabel(t, f).toLowerCase()).join(", "),
          ),
        );
        return;
      }
    }
    if (accountType === "custom") {
      const { invalid } = collectCustomAssets();
      if (invalid > 0) {
        setErr(t.editAcct.customAssetInvalid);
        return;
      }
    }

    setBusy(true);
    setBusyStage("saving");
    try {
      const payload = buildAccountPayload();
      const saved = isNew
        ? await api.createAccount(payload)
        : await api.updateAccount(account!.id, payload);

      // For exchange type, persist creds if any field has a value (new entries
      // require all fields up front; edits are merge-style).
      if (accountType === "exchange") {
        const hasAny = currentExchange.fields.some(
          (f) => credValues[f].trim().length > 0,
        );
        if (isNew || hasAny) {
          const credPayload: CexCredentialInput = {
            exchange: currentExchange.id,
            api_key: credValues.api_key.trim(),
            api_secret: credValues.api_secret.trim(),
            passphrase: credValues.passphrase.trim(),
            wallet_address: credValues.wallet_address.trim(),
          };
          await api.setCexCredential(saved.id, credPayload);
        }
      }

      // For brand-new accounts, immediately try a sync — we only want to
      // commit accounts whose data we can actually load. If sync fails or
      // gets skipped, roll back the just-created account.
      // Custom accounts have no remote sync; the balance was set inline
      // from the user-entered assets, so skip this guard.
      if (isNew && accountType !== "custom") {
        setBusyStage("syncing");
        let syncOk = false;
        let syncMsg = "";
        try {
          const result = await api.syncAccount(saved.id);
          // Server may have deducted a credit on our behalf — refresh so the
          // nav counter is accurate immediately after creating an account.
          void refreshAuth();
          syncOk = result.status === "ok";
          syncMsg = result.message ?? "";
          if (!syncOk && result.status === "skipped") {
            syncMsg = `skipped — ${result.message ?? "no data loaded"}`;
          }
          if (!syncOk && result.status === "error") {
            syncMsg = `error — ${result.message ?? "sync failed"}`;
          }
        } catch (e) {
          syncOk = false;
          syncMsg =
            e instanceof ApiError
              ? e.message
              : e instanceof Error
                ? e.message
                : "sync failed";
        }

        if (!syncOk) {
          // Roll back — the account was created but we couldn't load its
          // data, and the user asked that such accounts not be added.
          try {
            await api.deleteAccount(saved.id);
          } catch {
            // best-effort — surface the sync error to the user regardless
          }
          setErr(t.editAcct.couldntLoad(syncMsg));
          return;
        }
      }

      onSaved(saved);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setErr(t.editAcct.nameTaken(name.trim()));
      } else if (e instanceof ApiError) setErr(e.message);
      else setErr(e instanceof Error ? e.message : t.editAcct.saveFailed);
    } finally {
      setBusy(false);
      setBusyStage(null);
    }
  }

  function buildAccountPayload(): AccountInput {
    const base = { name: name.trim(), group, note };
    if (accountType === "onchain") {
      return {
        ...base,
        source: "onchain",
        addr: walletAddress.trim(),
        chain: chainLabelForKind(onchainKind),
      };
    }
    if (accountType === "exchange") {
      return {
        ...base,
        source: "exchange",
        addr: currentExchange.id,
        chain: null,
      };
    }
    const { clean } = collectCustomAssets();
    const payload: AccountInput = {
      ...base,
      source: "custom",
      addr: "",
      chain: null,
    };
    // Only send assets on create (to seed the snapshot) or when the user
    // actually filled something in — in edit mode, an all-blank form means
    // "leave existing assets alone", not "wipe them".
    if (isNew || clean.length > 0) payload.custom_assets = clean;
    return payload;
  }

  async function remove() {
    if (!account?.id || !confirm(t.editAcct.confirmDelete(account.name))) return;
    setBusy(true);
    try {
      await api.deleteAccount(account.id);
      onDeleted(account.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t.editAcct.deleteFailed);
    } finally {
      setBusy(false);
    }
  }

  const providerLabel = (() => {
    if (accountType === "onchain")
      return onchainKind === "evm" ? t.editAcct.providerDeBank : t.editAcct.providerCoinStats;
    if (accountType === "exchange") return currentExchange.label;
    return t.editAcct.providerManual;
  })();

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "rgba(26,24,20,0.35)",
        backdropFilter: "blur(2px)",
        WebkitBackdropFilter: "blur(2px)",
        overflowY: "auto",
        display: "flex",
        justifyContent: "center",
        padding: "40px 20px",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="sketch-box thick p-16"
        style={{
          width: "100%",
          maxWidth: 480,
          margin: "auto",
          background: "#fbfbfa",
          boxShadow: "10px 10px 0 rgba(26,24,20,0.12)",
        }}
      >
        <div className="row between mb-12">
          <span className="head" style={{ fontSize: 20 }}>
            {isNew ? t.editAcct.addTitle : t.editAcct.editTitle}
          </span>
          <span
            style={{ cursor: "pointer", fontSize: 18, color: "var(--muted)" }}
            onClick={onClose}
          >
            ✕
          </span>
        </div>

        {!isNew && (
          <div
            className="row between mb-12 p-12 sketch-box"
            style={{ background: "rgba(26,24,20,0.03)" }}
          >
            <div className="col" style={{ gap: 2 }}>
              <span className="tiny">{t.editAcct.currentBalance}</span>
              <span className="head" style={{ fontSize: 22 }}>
                {fmt$(account?.bal ?? 0)}
              </span>
            </div>
            <div className="col" style={{ alignItems: "flex-end", gap: 2 }}>
              <span className="tiny">{t.editAcct.syncVia}</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                {providerLabel}
              </span>
            </div>
          </div>
        )}

        {/* Account type */}
        <div className="mono-xs mb-8">{t.editAcct.accountType}</div>
        <div className="row wrap" style={{ gap: 6, marginBottom: 12 }}>
          {(
            [
              ["onchain", t.editAcct.typeOnchain],
              ["exchange", t.editAcct.typeExchange],
              ["custom", t.editAcct.typeCustom],
            ] as [SourceType, string][]
          ).map(([type, label]) => (
            <span
              key={type}
              onClick={() => !isNew ? null : setAccountType(type)}
              className={"pill" + (accountType === type ? " active" : "")}
              style={{
                cursor: isNew ? "pointer" : "not-allowed",
                opacity: isNew || accountType === type ? 1 : 0.4,
              }}
              title={isNew ? undefined : t.editAcct.cannotChangeType}
            >
              {label}
            </span>
          ))}
        </div>

        {/* Type-specific fields — primary selector/lead info renders first,
             then the display name, then the secondary inputs. */}
        {accountType === "onchain" && (
          <OnchainFields
            kind={onchainKind}
            setKind={setOnchainKind}
            addr={walletAddress}
            setAddr={setWalletAddress}
            name={name}
            setName={setName}
          />
        )}

        {accountType === "exchange" && (
          <ExchangeFields
            isNew={isNew}
            exchangeId={exchangeId}
            setExchangeId={setExchangeId}
            credValues={credValues}
            patchCred={patchCred}
            existingCred={existingCred}
            name={name}
            setName={setName}
          />
        )}

        {accountType === "custom" && (
          <CustomFields
            name={name}
            setName={setName}
            assets={customAssets}
            setAssets={setCustomAssets}
          />
        )}

        {/* Group */}
        <div className="mono-xs mb-8">{t.editAcct.group}</div>
        <div className="row wrap" style={{ gap: 6, marginBottom: 14 }}>
          {groups
            .filter((g) => g.name.toLowerCase() !== "unassigned")
            .map((g) => (
              <span
                key={g.name}
                onClick={() => setGroup(g.name.toLowerCase())}
                className={
                  "pill" + (group === g.name.toLowerCase() ? " active" : "")
                }
              >
                <span
                  style={{
                    display: "inline-block",
                    width: 8,
                    height: 8,
                    background: g.color,
                    borderRadius: 2,
                    marginRight: 6,
                    verticalAlign: "middle",
                  }}
                />
                {g.name}
              </span>
            ))}
          <span
            onClick={() => setGroup("unassigned")}
            className={"pill" + (group === "unassigned" ? " active" : "")}
            title={t.editAcct.unassignedTip}
          >
            <span
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                background: "#8a8376",
                borderRadius: 2,
                marginRight: 6,
                verticalAlign: "middle",
                opacity: 0.5,
              }}
            />
            {t.editAcct.unassigned}
          </span>
          <span
            onClick={() => setGroupModalOpen(true)}
            className="pill"
            style={{ borderStyle: "dashed" }}
            title={t.editAcct.newGroupTip}
          >
            {t.editAcct.newGroupBtn}
          </span>
        </div>

        {/* Note */}
        <div className="mono-xs mb-8">{t.editAcct.noteOptional}</div>
        <textarea
          className="winput"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t.editAcct.notePlaceholder}
          rows={2}
          style={{ marginBottom: 12, resize: "vertical" }}
        />

        {err && (
          <div className="tiny" style={{ marginBottom: 8, color: "#e53935" }}>
            {err}
          </div>
        )}

        <div className="row between" style={{ marginTop: 6 }}>
          {!isNew ? (
            <button className="wbtn accent" onClick={remove} disabled={busy}>
              {t.editAcct.removeBtn}
            </button>
          ) : (
            <span />
          )}
          <div className="row" style={{ gap: 6 }}>
            <button className="wbtn" onClick={onClose} disabled={busy}>
              {t.editAcct.cancel}
            </button>
            <button
              className="wbtn primary"
              onClick={save}
              disabled={busy || !name}
            >
              {busy ? (
                <>
                  <span className="spin" style={{ marginRight: 6 }}>
                    ↻
                  </span>
                  {busyStage === "syncing"
                    ? t.editAcct.loadingData
                    : isNew
                      ? t.editAcct.addingDots
                      : t.editAcct.saving}
                </>
              ) : isNew ? (
                t.editAcct.addBtn
              ) : (
                t.editAcct.saveBtn
              )}
            </button>
          </div>
        </div>
      </div>

      {groupModalOpen && (
        <NewGroupModal
          zIndex={70}
          onClose={() => setGroupModalOpen(false)}
          onCreated={(created) => {
            // Auto-select the newly created group so the user doesn't have
            // to click it again.
            setGroup(created.name.toLowerCase());
            onGroupsChanged?.();
          }}
        />
      )}
    </div>
  );
}

/* ── Sub-sections ─────────────────────────────────────────────────────── */

function OnchainFields({
  kind,
  setKind,
  addr,
  setAddr,
  name,
  setName,
}: {
  kind: OnchainKind;
  setKind: (k: OnchainKind) => void;
  addr: string;
  setAddr: (v: string) => void;
  name: string;
  setName: (v: string) => void;
}) {
  const t = useTranslation();
  return (
    <>
      <div className="mono-xs mb-8">{t.editAcct.network}</div>
      <div className="row wrap" style={{ gap: 6, marginBottom: 14 }}>
        <span
          onClick={() => setKind("evm")}
          className={"pill" + (kind === "evm" ? " active" : "")}
          title={t.editAcct.evmTip}
        >
          EVM
          <span
            className="tiny"
            style={{
              marginLeft: 6,
              color: kind === "evm" ? "rgba(245,241,232,0.7)" : "var(--muted)",
            }}
          >
            DeBank
          </span>
        </span>
        <span
          onClick={() => setKind("solana")}
          className={"pill" + (kind === "solana" ? " active" : "")}
          title={t.editAcct.solanaTip}
        >
          Solana
          <span
            className="tiny"
            style={{
              marginLeft: 6,
              color: kind === "solana" ? "rgba(245,241,232,0.7)" : "var(--muted)",
            }}
          >
            CoinStats
          </span>
        </span>
        <span
          onClick={() => setKind("sui")}
          className={"pill" + (kind === "sui" ? " active" : "")}
          title={t.editAcct.suiTip}
        >
          Sui
          <span
            className="tiny"
            style={{
              marginLeft: 6,
              color: kind === "sui" ? "rgba(245,241,232,0.7)" : "var(--muted)",
            }}
          >
            CoinStats
          </span>
        </span>
        <span
          onClick={() => setKind("cosmos")}
          className={"pill" + (kind === "cosmos" ? " active" : "")}
          title={t.editAcct.cosmosTip}
        >
          Cosmos
          <span
            className="tiny"
            style={{
              marginLeft: 6,
              color: kind === "cosmos" ? "rgba(245,241,232,0.7)" : "var(--muted)",
            }}
          >
            CoinStats
          </span>
        </span>
      </div>

      <div className="mono-xs mb-8">{t.editAcct.displayName}</div>
      <input
        className="winput"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t.editAcct.displayNamePlaceholderOnchain}
        style={{ marginBottom: 14 }}
      />

      <div className="mono-xs mb-8">{t.editAcct.walletAddress}</div>
      <input
        className="winput"
        value={addr}
        onChange={(e) => setAddr(e.target.value)}
        placeholder={
          kind === "solana"
            ? t.editAcct.walletAddressPlaceholderSolana
            : kind === "sui"
            ? t.editAcct.walletAddressPlaceholderSui
            : kind === "cosmos"
            ? t.editAcct.walletAddressPlaceholderCosmos
            : t.editAcct.walletAddressPlaceholderEvm
        }
        style={{ marginBottom: 14 }}
      />
    </>
  );
}

function ExchangeFields({
  isNew,
  exchangeId,
  setExchangeId,
  credValues,
  patchCred,
  existingCred,
  name,
  setName,
}: {
  isNew: boolean;
  exchangeId: string;
  setExchangeId: (id: string) => void;
  credValues: Record<CredField, string>;
  patchCred: (f: CredField, v: string) => void;
  existingCred: CexCredentialStatus | null;
  name: string;
  setName: (v: string) => void;
}) {
  const t = useTranslation();
  const ex = EXCHANGES.find((e) => e.id === exchangeId) ?? EXCHANGES[0];

  const fieldHasSaved = (f: CredField): boolean => {
    if (!existingCred) return false;
    switch (f) {
      case "api_key":
        return existingCred.has_api_key;
      case "api_secret":
        return existingCred.has_api_secret;
      case "passphrase":
        return existingCred.has_passphrase;
      case "wallet_address":
        return existingCred.has_wallet_address;
    }
  };

  return (
    <>
      <div className="mono-xs mb-8">{t.editAcct.exchange}</div>
      <select
        className="winput"
        value={exchangeId}
        onChange={(e) => setExchangeId(e.target.value)}
        disabled={!isNew}
        title={!isNew ? t.editAcct.cannotChangeExchange : undefined}
        style={{ marginBottom: 14 }}
      >
        {EXCHANGES.map((e) => (
          <option key={e.id} value={e.id}>
            {e.label}
          </option>
        ))}
      </select>

      <div className="mono-xs mb-8">{t.editAcct.displayName}</div>
      <input
        className="winput"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t.editAcct.displayNamePlaceholderExchange}
        style={{ marginBottom: 14 }}
      />

      <div
        className="mono-xs mb-8"
        title={t.editAcct.credentialsTip}
      >
        {t.editAcct.credentials}
      </div>
      <div className="col" style={{ gap: 8, marginBottom: 14 }}>
        {ex.fields.map((f) => {
          const saved = fieldHasSaved(f);
          const label = fieldLabel(t, f);
          return (
            <div key={f} className="col" style={{ gap: 3 }}>
              <input
                className="winput"
                type={FIELD_IS_SECRET[f] ? "password" : "text"}
                value={credValues[f]}
                onChange={(e) => patchCred(f, e.target.value)}
                placeholder={
                  isNew
                    ? label
                    : saved
                      ? `${label}${t.editAcct.keepSavedSuffix}`
                      : label
                }
              />
            </div>
          );
        })}
        <div className="tiny" style={{ color: "var(--muted)" }}>
          {t.editAcct.serverSide}
        </div>
      </div>
    </>
  );
}

function CustomFields({
  name,
  setName,
  assets,
  setAssets,
}: {
  name: string;
  setName: (v: string) => void;
  assets: CustomAssetRow[];
  setAssets: Dispatch<SetStateAction<CustomAssetRow[]>>;
}) {
  const t = useTranslation();
  const [priceBusy, setPriceBusy] = useState<Set<number>>(new Set());
  const [priceErr, setPriceErr] = useState<{ idx: number; msg: string } | null>(null);

  const patchRow = (idx: number, patch: Partial<CustomAssetRow>) =>
    setAssets((rows) =>
      rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    );
  const addRow = () =>
    setAssets((rows) => [...rows, { ...EMPTY_ASSET_ROW }]);
  const removeRow = (idx: number) =>
    setAssets((rows) =>
      rows.length <= 1 ? [{ ...EMPTY_ASSET_ROW }] : rows.filter((_, i) => i !== idx),
    );

  async function fetchLivePrice(idx: number, symbol: string) {
    const sym = symbol.trim();
    if (!sym) {
      setPriceErr({ idx, msg: t.editAcct.enterSymbol });
      return false;
    }
    setPriceErr(null);
    setPriceBusy((s) => new Set(s).add(idx));
    try {
      const { price_usd } = await api.spotPrice(sym);
      patchRow(idx, { unit_price: String(price_usd) });
      return true;
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? e.status === 404
            ? t.editAcct.noLivePrice(sym.toUpperCase())
            : e.message
          : e instanceof Error
            ? e.message
            : t.editAcct.priceFailed;
      setPriceErr({ idx, msg });
      return false;
    } finally {
      setPriceBusy((s) => {
        const next = new Set(s);
        next.delete(idx);
        return next;
      });
    }
  }

  async function setPriceSource(idx: number, next: PriceSource, symbol: string) {
    patchRow(idx, { price_source: next });
    if (next === "api" && symbol.trim()) {
      await fetchLivePrice(idx, symbol);
    }
  }

  const subtotal = assets.reduce((acc, r) => {
    const a = Number(r.amount);
    const p = Number(r.unit_price);
    if (!r.symbol.trim() || !Number.isFinite(a) || !Number.isFinite(p)) return acc;
    return acc + a * p;
  }, 0);

  return (
    <>
      <div
        className="sketch-box p-12"
        style={{
          background: "rgba(242,193,78,0.12)",
          borderStyle: "dashed",
          marginBottom: 14,
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        <b>{t.editAcct.customBoxBold}</b>{" "}
        <span style={{ color: "var(--ink-2)" }}>{t.editAcct.customBoxBody}</span>
      </div>

      <div className="mono-xs mb-8">{t.editAcct.displayName}</div>
      <input
        className="winput"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t.editAcct.displayNamePlaceholderCustom}
        style={{ marginBottom: 14 }}
      />

      <div className="row between mb-8">
        <span className="mono-xs">{t.editAcct.assetsHeader}</span>
        <span className="tiny" style={{ color: "var(--muted)" }}>
          {t.editAcct.subtotal(
            subtotal.toLocaleString(undefined, { maximumFractionDigits: 2 }),
          )}
        </span>
      </div>
      <div className="col" style={{ gap: 8, marginBottom: 10 }}>
        {assets.map((row, idx) => {
          const busy = priceBusy.has(idx);
          const isApi = row.price_source === "api";
          return (
            <div key={idx} className="col" style={{ gap: 3 }}>
              <div className="row" style={{ gap: 6, alignItems: "center" }}>
                <input
                  className="winput"
                  value={row.symbol}
                  onChange={(e) => patchRow(idx, { symbol: e.target.value })}
                  placeholder={t.editAcct.symbolPlaceholder}
                  style={{ flex: "1 1 80px", textTransform: "uppercase" }}
                />
                <input
                  className="winput"
                  value={row.amount}
                  onChange={(e) => patchRow(idx, { amount: e.target.value })}
                  placeholder={t.editAcct.amountPlaceholder}
                  inputMode="decimal"
                  style={{ flex: "1 1 90px" }}
                />
                <input
                  className="winput"
                  value={row.unit_price}
                  onChange={(e) => patchRow(idx, { unit_price: e.target.value })}
                  placeholder={isApi ? t.editAcct.autoLive : t.editAcct.unitPricePlaceholder}
                  inputMode="decimal"
                  readOnly={isApi}
                  disabled={isApi}
                  title={isApi ? t.editAcct.priceLockedTip : undefined}
                  style={{
                    flex: "1 1 90px",
                    opacity: isApi ? 0.65 : 1,
                    cursor: isApi ? "not-allowed" : "text",
                  }}
                />
                <button
                  type="button"
                  className="wbtn"
                  onClick={() => removeRow(idx)}
                  title={t.editAcct.removeAsset}
                  style={{ padding: "2px 8px", fontSize: 11 }}
                >
                  ✕
                </button>
              </div>
              <div className="row" style={{ gap: 6, alignItems: "center" }}>
                <span className="tiny" style={{ color: "var(--muted)" }}>
                  {t.editAcct.pricePrefix}
                </span>
                <span
                  onClick={() => setPriceSource(idx, "custom", row.symbol)}
                  className={"pill" + (!isApi ? " active" : "")}
                  style={{ fontSize: 10, padding: "1px 8px", cursor: "pointer" }}
                  title={t.editAcct.priceCustomTip}
                >
                  {t.editAcct.priceCustom}
                </span>
                <span
                  onClick={() => setPriceSource(idx, "api", row.symbol)}
                  className={"pill" + (isApi ? " active" : "")}
                  style={{ fontSize: 10, padding: "1px 8px", cursor: "pointer" }}
                  title={t.editAcct.priceApiTip}
                >
                  {t.editAcct.priceApi} {isApi && busy ? "…" : ""}
                </span>
                {isApi && (
                  <button
                    type="button"
                    className="wbtn"
                    onClick={() => fetchLivePrice(idx, row.symbol)}
                    disabled={busy}
                    title={t.editAcct.priceRefreshTip}
                    style={{ padding: "1px 8px", fontSize: 10 }}
                  >
                    {busy ? "…" : t.editAcct.priceRefresh}
                  </button>
                )}
              </div>
              {priceErr?.idx === idx && (
                <div className="tiny accent" style={{ paddingLeft: 2 }}>
                  {priceErr.msg}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="wbtn"
        onClick={addRow}
        style={{ marginBottom: 14, padding: "2px 10px", fontSize: 11 }}
      >
        {t.editAcct.addAsset}
      </button>
    </>
  );
}
