/**
 * The localized strings this bundle owns.
 *
 * They live in the `dsh-hint-shell` namespace, which no shipped bundle claims.
 * Registering into `conversation` would throw: that namespace already owns `zh`
 * and `en`, and locale registration is append-only — there is no per-key merge.
 */

/** Namespace owned by this bundle. */
export const NS = 'dsh-hint-shell';

/**
 * Clause appended to the idle composer placeholder.
 *
 * The shipped zh placeholder ends with `@ 文件或对话`, so a full-width comma
 * keeps the result reading as one sentence; en does the same with `, `.
 */
export const IDLE_PHRASE: Readonly<Record<string, string>> = {
  zh: '，输入 ! 执行 shell 命令',
  en: ', type ! for shell commands',
};

/**
 * Hint shown once `!` is typed and no command follows yet.
 *
 * Carries no surrounding punctuation: upstream paints it with `::after` right
 * after the typed glyph, and the caller supplies the separating space.
 */
export const ARMED_HINT: Readonly<Record<string, string>> = {
  zh: '输入 shell 命令…',
  en: 'Enter a shell command…',
};

/** Dictionary registered under {@link NS}; `meta` powers the plugin listing. */
export const DICTIONARY: Readonly<Record<string, Record<string, string>>> = {
  zh: {
    meta: '输入框 shell 命令提示',
    idle: IDLE_PHRASE['zh'] ?? '',
    armed: ARMED_HINT['zh'] ?? '',
  },
  en: {
    meta: 'Composer shell command hint',
    idle: IDLE_PHRASE['en'] ?? '',
    armed: ARMED_HINT['en'] ?? '',
  },
};

/**
 * Read one owned string, falling back when the namespace lookup misses.
 *
 * The locale service resolves through a fallback chain that always ends in
 * `en`, so a language this bundle has no dictionary for still yields English
 * rather than a raw key.
 *
 * @param t - translator bound to {@link NS}
 * @param key - owned key
 * @param fallback - text to use when the lookup returns the key itself
 * @returns the localized text
 */
export function textOf(
  t: (key: string) => string,
  key: 'idle' | 'armed',
  fallback: string,
): string {
  const translated = t(key);
  return translated === key ? fallback : translated;
}
