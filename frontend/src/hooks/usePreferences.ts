import { useCallback, useEffect, useState } from "react";

export interface Preferences {
  hideLowBalance: boolean;
  lowBalanceThreshold: number;
  lang: string;
}

const DEFAULTS: Preferences = {
  hideLowBalance: true,
  lowBalanceThreshold: 1,
  lang: "EN",
};

const STORAGE_KEY = "portfolio:prefs:v1";
const SUPPORTED_LANGS = ["EN", "ZH"] as const;

function read(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    const merged = { ...DEFAULTS, ...parsed };
    if (!SUPPORTED_LANGS.includes(merged.lang as (typeof SUPPORTED_LANGS)[number])) {
      merged.lang = DEFAULTS.lang;
    }
    if (
      typeof merged.lowBalanceThreshold !== "number" ||
      !Number.isFinite(merged.lowBalanceThreshold) ||
      merged.lowBalanceThreshold < 0
    ) {
      merged.lowBalanceThreshold = DEFAULTS.lowBalanceThreshold;
    }
    return merged;
  } catch {
    return DEFAULTS;
  }
}

// Module-level singleton so every hook instance observes the same value and
// a change made in one component (e.g. the user menu) is reflected in another
// (e.g. the dashboard "hide low balance" toggle) without a round-trip through
// storage events.
let current = read();
const listeners = new Set<(p: Preferences) => void>();

function write(next: Preferences): void {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore quota / private-mode failures
  }
  listeners.forEach((l) => l(next));
}

/** Read the current language outside React (e.g. from the API client at
 *  request time). The hook variant is preferred inside components — this
 *  exists so signup / password-reset / resend calls can tag themselves with
 *  the website language without threading a prop through every caller. */
export function getCurrentLang(): string {
  return current.lang;
}

export function usePreferences(): {
  prefs: Preferences;
  setPref: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
} {
  const [prefs, setPrefs] = useState<Preferences>(current);

  useEffect(() => {
    listeners.add(setPrefs);
    return () => {
      listeners.delete(setPrefs);
    };
  }, []);

  const setPref = useCallback(
    <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
      write({ ...current, [key]: value });
    },
    [],
  );

  return { prefs, setPref };
}
