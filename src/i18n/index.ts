/**
 * Internationalization (i18n) module for dmux
 *
 * Translations are bundled as TypeScript modules (no fs/JSON at runtime).
 * This keeps published builds self-contained and avoids fs side effects
 * for non-UI consumers (e.g. SettingsManager) and tests.
 */

import en from './locales/en.js';
import ja from './locales/ja.js';

export type Locale = 'en' | 'ja';

export interface Translations {
  [key: string]: string | Translations;
}

const TRANSLATIONS: Record<Locale, Translations> = {
  en,
  ja,
};

const LOCALE_LABELS: Array<{ value: Locale; label: string }> = [
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
];

class I18nManager {
  private currentLocale: Locale = 'en';
  private fallbackLocale: Locale = 'en';

  setLocale(locale: Locale): void {
    if (locale in TRANSLATIONS) {
      this.currentLocale = locale;
    }
  }

  getLocale(): Locale {
    return this.currentLocale;
  }

  getAvailableLocales(): Array<{ value: Locale; label: string }> {
    return LOCALE_LABELS.slice();
  }

  t(key: string, params?: Record<string, string | number>): string {
    const resolved =
      this.lookup(this.currentLocale, key) ??
      this.lookup(this.fallbackLocale, key);

    if (typeof resolved !== 'string') {
      return key;
    }

    if (params) {
      return resolved.replace(/\{(\w+)\}/g, (match, paramName) =>
        params[paramName] !== undefined ? String(params[paramName]) : match
      );
    }

    return resolved;
  }

  private lookup(locale: Locale, key: string): string | undefined {
    let value: string | Translations | undefined = TRANSLATIONS[locale];
    for (const segment of key.split('.')) {
      if (value && typeof value === 'object' && segment in value) {
        value = (value as Translations)[segment];
      } else {
        return undefined;
      }
    }
    return typeof value === 'string' ? value : undefined;
  }
}

const i18n = new I18nManager();
export default i18n;

export function t(key: string, params?: Record<string, string | number>): string {
  return i18n.t(key, params);
}

export function setLocale(locale: Locale): void {
  i18n.setLocale(locale);
}

export function getLocale(): Locale {
  return i18n.getLocale();
}

export function getAvailableLocales(): Array<{ value: Locale; label: string }> {
  return i18n.getAvailableLocales();
}
