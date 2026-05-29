export const fmt$ = (n: number): string =>
  "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });

export const fmt$k = (n: number): string => {
  if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (Math.abs(n) >= 1e3) return "$" + (n / 1e3).toFixed(1) + "k";
  return "$" + n.toFixed(0);
};

export const fmtPct = (n: number): string =>
  (n >= 0 ? "+" : "") + n.toFixed(2) + "%";

export const seeded = (seed: number): (() => number) => {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
};

/**
 * Human-readable source label for an account:
 * - onchain → "EVM" or "Solana" (from `chain`)
 * - exchange → exchange name, capitalized (from `addr`)
 * - custom → "Custom"
 */
export const sourceLabel = (a: {
  source: string;
  addr: string;
  chain?: string | null;
}): string => {
  if (a.source === "onchain") return a.chain || "—";
  if (a.source === "exchange") {
    const raw = (a.addr || "").trim();
    if (!raw) return "—";
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }
  if (a.source === "custom") return "Custom";
  return "—";
};
