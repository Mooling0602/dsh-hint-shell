/**
 * Structural views of the services this bundle consumes.
 *
 * This bundle is self-contained: it needs the locale service and nothing else.
 * The composer draft is read from the DOM attribute the shipped composer
 * already publishes, so no other plugin has to exist.
 */

/** Locale snapshot, as much as this bundle reads it. */
export interface LocaleSnapshot {
  /** Active BCP 47-style language tag, e.g. `zh-CN`. */
  readonly active: string;
}

/** The locale service surface used by this bundle. */
export interface LocaleService {
  register(
    ns: string,
    localeOrDicts: string | Record<string, Record<string, string>>,
    dict?: Record<string, string>,
  ): () => void;
  bind(ns: string): (key: string, params?: Record<string, string | number>) => string;
  getSnapshot(): LocaleSnapshot;
  subscribe(listener: () => void): () => void;
}

/** Minimal structural view of the Cordis client context used here. */
export interface ClientPluginContext {
  readonly locale: LocaleService;
  effect(callback: () => () => void, label?: string): void;
}
