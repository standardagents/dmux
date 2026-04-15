/**
 * Internationalization (i18n) module for dmux
 * Provides multi-language support with translation files
 */

import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type Locale = 'en' | 'ja';

export interface Translations {
  [key: string]: string | Translations;
}

class I18nManager {
  private currentLocale: Locale = 'en';
  private translations: Map<Locale, Translations> = new Map();
  private fallbackLocale: Locale = 'en';

  constructor() {
    this.loadTranslations();
  }

  private loadTranslations(): void {
    try {
      const localesDir = join(__dirname, 'locales');
      const files = readdirSync(localesDir).filter(f => f.endsWith('.json'));
      
      for (const file of files) {
        const locale = file.replace('.json', '') as Locale;
        const filePath = join(localesDir, file);
        const translations = JSON.parse(readFileSync(filePath, 'utf-8'));
        this.translations.set(locale, translations);
      }
    } catch (error) {
      console.error('Failed to load translations:', error);
    }
  }

  /**
   * Set the current locale
   */
  setLocale(locale: Locale): void {
    this.currentLocale = locale;
  }

  /**
   * Get the current locale
   */
  getLocale(): Locale {
    return this.currentLocale;
  }

  /**
   * Get available locales
   */
  getAvailableLocales(): Array<{ value: Locale; label: string }> {
    return [
      { value: 'en', label: 'English' },
      { value: 'ja', label: '日本語' },
    ];
  }

  /**
   * Translate a key to the current locale
   * @param key - Dot-notation key (e.g., 'settings.title')
   * @param params - Optional parameters for interpolation
   */
  t(key: string, params?: Record<string, string | number>): string {
    const keys = key.split('.');
    let value: string | Translations | undefined = this.translations.get(this.currentLocale);

    // Navigate through nested keys
    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        value = undefined;
        break;
      }
    }

    // If not found, try fallback locale
    if (value === undefined) {
      value = this.translations.get(this.fallbackLocale);
      for (const k of keys) {
        if (value && typeof value === 'object' && k in value) {
          value = value[k];
        } else {
          value = undefined;
          break;
        }
      }
    }

    // If still not found, return the key itself
    if (typeof value !== 'string') {
      return key;
    }

    // Interpolate parameters if provided
    if (params) {
      return value.replace(/\{(\w+)\}/g, (match, paramName) => {
        return params[paramName] !== undefined ? String(params[paramName]) : match;
      });
    }

    return value;
  }
}

// Singleton instance
const i18n = new I18nManager();

export default i18n;

// Convenience function
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
