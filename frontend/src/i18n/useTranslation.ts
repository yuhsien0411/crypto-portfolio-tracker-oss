import { usePreferences } from "../hooks/usePreferences";
import { en, type TranslationDict } from "./en";
import { zh } from "./zh";
import { zhTw } from "./zhTw";

const DICTS: Record<string, TranslationDict> = { EN: en, ZH: zh, ZH_TW: zhTw };

/**
 * Tiny i18n hook. Returns the typed translation dict for the current language
 * preference (re-rendering automatically when the user toggles language).
 *
 * Usage:
 *   const t = useTranslation();
 *   <h1>{t.dashboard.title}</h1>
 *   <button>{t.userMenu.logout}</button>
 */
export function useTranslation(): TranslationDict {
  const { prefs } = usePreferences();
  return DICTS[prefs.lang] ?? en;
}
