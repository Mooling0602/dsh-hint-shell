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
  /** Shared configuration forms, one per Host entry (provided by `configForms`). */
  readonly configForms: ConfigFormsService;
  /** Slot registry the Plugins page renders contributed entries through. */
  readonly slots: SlotsService;
  effect(callback: () => () => void, label?: string): void;
}

/** The shared configuration form of one Host entry. */
export interface ConfigFormScope<T> {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable';
    value: T | undefined;
    base: unknown;
    user: unknown;
    writable: boolean;
    revision: number | undefined;
  };
  subscribe(listener: () => void): () => void;
  mutate(
    ops: readonly (
      | { op: 'set'; path: readonly string[]; value: unknown }
      | { op: 'unset'; path: readonly string[] }
    )[],
    expectedRevision?: number,
  ): Promise<boolean>;
}

/** The `configForms` service, narrowed to what this bundle calls. */
export interface ConfigFormsService {
  /** @param ns - settings namespace, which is the profile entry id. */
  get<T>(ns: string): ConfigFormScope<T>;
  /**
   * Run the callback once the Host serves every named namespace, and again
   * whenever that set changes.
   *
   * @param namespaces - settings namespaces to wait for.
   * @param callback - receives the set currently served.
   * @returns a disposer that withdraws the registration.
   */
  whileServed(
    namespaces: readonly string[],
    callback: (served: ReadonlySet<string>) => (() => void) | void,
  ): () => void;
}

/** One slot registration's declaration. */
export interface SlotRegistration {
  /** Slot key, e.g. `plugins.row.config`. */
  name: string;
  /**
   * Dispatch key of a keyed slot — `<package name>#<row id>` for a bundle row's
   * configuration. List slots take `id`/`order`/`label` instead.
   */
  key?: string;
  /** Locale namespace the entry's copy reads through. */
  locale?: string;
  /** The face injected into the component's props. */
  inject?: () => object;
}

/** The `slots` service, narrowed to what this bundle calls. */
export interface SlotsService {
  register(declaration: SlotRegistration, component: unknown): () => void;
  inject(name: string, callback: () => () => void): () => void;
}
