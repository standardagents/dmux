import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  t,
  setLocale,
  getLocale,
  getAvailableLocales,
  type Locale,
  type Translations,
} from '../src/i18n/index.js';

describe('i18n', () => {
  beforeEach(() => {
    setLocale('en');
  });

  describe('locale switching', () => {
    it('defaults to English', () => {
      expect(getLocale()).toBe('en');
    });

    it('switches to Japanese via setLocale', () => {
      setLocale('ja');
      expect(getLocale()).toBe('ja');
    });

    it('ignores unknown locales', () => {
      setLocale('ja');
      setLocale('zz' as Locale);
      expect(getLocale()).toBe('ja');
    });
  });

  describe('translation lookup (real bundled locales)', () => {
    it('returns the English string by default', () => {
      expect(t('settings.title')).toBe('Settings');
    });

    it('returns the Japanese string after switching locale', () => {
      setLocale('ja');
      expect(t('settings.title')).toBe('設定');
    });

    it('returns the key itself when neither locale has it', () => {
      expect(t('totally.bogus.key')).toBe('totally.bogus.key');
      setLocale('ja');
      expect(t('totally.bogus.key')).toBe('totally.bogus.key');
    });

    it('handles nested dot-notation keys', () => {
      expect(t('menu.settings')).toBe('[S] Settings');
      setLocale('ja');
      expect(t('menu.settings')).toBe('[S] 設定');
    });

    it('returns the key when traversal hits a string before exhausting segments', () => {
      // settings.title resolves to "Settings" — drilling further must fail
      expect(t('settings.title.further.path')).toBe('settings.title.further.path');
    });
  });

  describe('available locales', () => {
    it('lists English and Japanese', () => {
      const locales = getAvailableLocales();
      expect(locales).toEqual([
        { value: 'en', label: 'English' },
        { value: 'ja', label: '日本語' },
      ]);
    });

    it('returns a fresh array each call (no shared mutable reference)', () => {
      const a = getAvailableLocales();
      const b = getAvailableLocales();
      expect(a).not.toBe(b);
      a.push({ value: 'fr' as Locale, label: 'French' });
      expect(getAvailableLocales()).toHaveLength(2);
    });
  });

  describe('translation completeness (en ↔ ja parity)', () => {
    function collectLeafKeys(node: unknown, prefix = ''): string[] {
      if (node === null || typeof node !== 'object') {
        return [];
      }
      const keys: string[] = [];
      for (const key of Object.keys(node as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${key}` : key;
        const value = (node as Record<string, unknown>)[key];
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          keys.push(...collectLeafKeys(value, path));
        } else {
          keys.push(path);
        }
      }
      return keys.sort();
    }

    it('en and ja expose identical key trees (no orphan or missing translations)', async () => {
      const en = (await import('../src/i18n/locales/en.js')).default;
      const ja = (await import('../src/i18n/locales/ja.js')).default;

      const enKeys = collectLeafKeys(en);
      const jaKeys = collectLeafKeys(ja);

      expect(enKeys).toEqual(jaKeys);
    });

    it('every bundled key resolves to a non-key string in both locales', async () => {
      const en = (await import('../src/i18n/locales/en.js')).default;
      const keys = collectLeafKeys(en);

      // sanity: there must be a non-trivial number of keys to test against.
      expect(keys.length).toBeGreaterThan(20);

      for (const locale of ['en', 'ja'] as const) {
        setLocale(locale);
        for (const key of keys) {
          const translated = t(key);
          // If t() ever returns the key, the lookup failed — fail loudly with
          // the offending key/locale so the regression is obvious.
          expect(translated, `missing translation for "${key}" in ${locale}`).not.toBe(key);
          expect(translated.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('module side effects', () => {
    it('does not import fs / readFileSync / readdirSync in i18n source', async () => {
      // Source-level assertion: importing fs at module scope causes the
      // synchronous-load regression flagged in PR #73 review (settingsManager
      // and other non-UI consumers triggering fs reads at import time).
      // Keep this guard tight so future changes can't reintroduce it silently.
      const { readFile } = await import('node:fs/promises');
      const { fileURLToPath } = await import('node:url');
      const { join, dirname } = await import('node:path');

      const here = dirname(fileURLToPath(import.meta.url));
      const sourcePath = join(here, '..', 'src', 'i18n', 'index.ts');
      const source = await readFile(sourcePath, 'utf8');

      expect(source).not.toMatch(/from\s+['"]fs['"]/);
      expect(source).not.toMatch(/from\s+['"]node:fs['"]/);
      expect(source).not.toMatch(/\breadFileSync\b/);
      expect(source).not.toMatch(/\breaddirSync\b/);
    });
  });

  describe('parameter interpolation (mocked locales)', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    afterEach(() => {
      vi.doUnmock('../src/i18n/locales/en.js');
      vi.doUnmock('../src/i18n/locales/ja.js');
      vi.resetModules();
    });

    async function loadWithLocales(en: Translations, ja: Translations) {
      vi.doMock('../src/i18n/locales/en.js', () => ({ default: en }));
      vi.doMock('../src/i18n/locales/ja.js', () => ({ default: ja }));
      return await import('../src/i18n/index.js');
    }

    it('substitutes {param} placeholders through t()', async () => {
      const fresh = await loadWithLocales(
        { greet: 'Hello {name}, you have {count} item(s)' },
        {}
      );
      expect(fresh.t('greet', { name: 'world', count: 3 })).toBe(
        'Hello world, you have 3 item(s)'
      );
    });

    it('leaves unknown placeholders untouched', async () => {
      const fresh = await loadWithLocales(
        { greet: 'Hello {name}, you have {count}' },
        {}
      );
      expect(fresh.t('greet', { name: 'world' })).toBe(
        'Hello world, you have {count}'
      );
    });

    it('coerces numeric parameter values to strings', async () => {
      const fresh = await loadWithLocales(
        { count: 'You have {count} item(s)' },
        {}
      );
      expect(fresh.t('count', { count: 0 })).toBe('You have 0 item(s)');
    });

    it('returns the resolved string unchanged when no params are passed', async () => {
      const fresh = await loadWithLocales(
        { plain: 'no placeholders here' },
        {}
      );
      expect(fresh.t('plain')).toBe('no placeholders here');
      expect(fresh.t('plain', {})).toBe('no placeholders here');
    });

    it('does not interpolate over the key when the key is missing', async () => {
      const fresh = await loadWithLocales({}, {});
      // Unknown keys come back as-is; params must not be applied to them.
      expect(fresh.t('missing.{name}', { name: 'X' })).toBe('missing.{name}');
    });
  });

  describe('fallback to English (mocked locales)', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    afterEach(() => {
      vi.doUnmock('../src/i18n/locales/en.js');
      vi.doUnmock('../src/i18n/locales/ja.js');
      vi.resetModules();
    });

    async function loadWithLocales(en: Translations, ja: Translations) {
      vi.doMock('../src/i18n/locales/en.js', () => ({ default: en }));
      vi.doMock('../src/i18n/locales/ja.js', () => ({ default: ja }));
      return await import('../src/i18n/index.js');
    }

    it('falls back to English when a key exists in en but not in the active locale', async () => {
      const fresh = await loadWithLocales(
        { only: { en: 'English only' } },
        {}
      );
      fresh.setLocale('ja');
      expect(fresh.t('only.en')).toBe('English only');
    });

    it('uses the active locale when both locales define the key', async () => {
      const fresh = await loadWithLocales(
        { greeting: 'Hello' },
        { greeting: 'こんにちは' }
      );
      fresh.setLocale('ja');
      expect(fresh.t('greeting')).toBe('こんにちは');
    });

    it('returns the key when neither locale has it', async () => {
      const fresh = await loadWithLocales({}, {});
      fresh.setLocale('ja');
      expect(fresh.t('nope')).toBe('nope');
    });
  });
});
