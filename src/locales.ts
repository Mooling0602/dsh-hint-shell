/**
 * The settings page's copy.
 *
 * The dictionaries are TypeScript constants rather than the `locale/*.json`
 * files in this repository. That is how every shipped settings page does it
 * (see `ui-settings-shell/src/client/locales.ts`): the locale service's
 * `register` takes dictionaries by value, and nothing in the client bundle
 * reads a JSON file at runtime, so a page whose strings lived only in JSON
 * would render raw keys. The JSON files remain the translator-facing source for
 * the hint surface and for `meta`, which the plugin listing reads through the
 * Host.
 */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives';

/** Locale keys the page renders. */
export type HintLocaleKey =
  | 'title' | 'description'
  | 'maxCommandChars' | 'maxCommandCharsHint'
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable'
  | 'save' | 'saving' | 'saveFailed' | 'invalidNumber'
  // The composer hints. One dictionary serves both surfaces: registering twice
  // into one namespace is not allowed, and two dictionaries that must stay in
  // step is exactly the drift a single namespace prevents.
  | 'idle' | 'armed';

/** Locale namespace this plugin owns. */
export const NS = 'dsh-hint-shell';

/**
 * This bundle's package name.
 *
 * The same string is the locale namespace and the profile entry id, and the
 * first half of the row-config key (`<package name>#<row id>`) the Plugins page
 * dispatches on.
 */
export const PACKAGE_NAME = 'dsh-hint-shell';

/** English copy. */
export const en: Record<HintLocaleKey, string> = {
  title: 'Shell hint',
  description: 'Type ! in an empty composer to run a shell command, with a cap on how long a command may be.',
  maxCommandChars: 'Command length cap (characters)',
  maxCommandCharsHint: 'A command longer than this is refused outright and never runs.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
  idle: ', type ! for shell commands',
  armed: 'Enter a shell command…',
};

/** Simplified Chinese copy. */
export const zh: Record<HintLocaleKey, string> = {
  title: 'Shell 提示',
  description: '在空输入框输入 ! 即可执行 shell 命令，并可调整命令长度上限。',
  maxCommandChars: '命令长度上限（字符）',
  maxCommandCharsHint: '超过此长度的命令会被直接拒绝，不会执行。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '此部署以只读方式存储设置。',
  unavailable: '该插件未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '该部署未接受这些值，已保留供你修改。',
  invalidNumber: '请输入数字，留空则使用默认值。',
  idle: ', 输入 ! 执行 shell 命令',
  armed: '输入 shell 命令…',
};

/**
 * Translate one key, returning the English copy when the dictionary misses.
 *
 * The locale service's fallback chain always ends in `en`, so a miss here means
 * a key is missing from every language rather than a language being absent;
 * returning the key itself would leak an identifier into the page.
 *
 * @param t - translator bound to this plugin's namespace
 * @param key - key to read
 * @returns the localized text
 */
export function text(t: (key: HintLocaleKey) => string, key: HintLocaleKey): string {
  const translated = t(key);
  return translated === key ? en[key] : translated;
}

/**
 * The shared settings form's frame copy.
 *
 * @param t - translator bound to this plugin's namespace
 * @returns the labels {@link SettingsFormLabels} requires
 */
export function formLabels(t: (key: HintLocaleKey) => string): SettingsFormLabels {
  return {
    unavailable: text(t, 'unavailable'),
    readOnly: text(t, 'readOnly'),
    saveFailed: text(t, 'saveFailed'),
    save: text(t, 'save'),
    saving: text(t, 'saving'),
  };
}
