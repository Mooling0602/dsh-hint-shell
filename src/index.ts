/**
 * dsh-hint-shell — Client half.
 *
 * Owns exactly two strings and produces exactly two effects. It replaces no
 * component, adds no control, and needs no other plugin.
 *
 * ── 1. Idle hint: nothing typed yet ────────────────────────────────────────
 *
 * The empty-composer placeholder comes from a locale lookup of
 * `conversation/placeholder.default`. `LocaleRuntime.prototype.translate` is a
 * prototype method, so wrapping it lets this bundle append one clause to that
 * key. The host keeps asking for the key it always asked for and renders its
 * own placeholder text plus the clause. Every other namespace and key passes
 * through untouched, so nothing else in the application can be affected.
 *
 * `placeholder.hero` is the same composer in its empty-session layout, so it
 * gets the same clause.
 *
 * ── 2. Armed hint: the draft is only `!` ───────────────────────────────────
 *
 * The shipped stylesheet already paints exactly this kind of message:
 *
 *     .input p:last-child:after { content: var(--dsh-composer-hint);
 *                                 color: var(--dsw-alias-label-caption) }
 *
 * Upstream only populates that property for a native command claim, which a `!`
 * prefix cannot produce. Custom properties inherit, so setting it on the
 * composer card is enough: the shipped rule then draws the text immediately
 * after the `!` the user typed, in the shipped caption colour, with no
 * positioning, measurement, or extra DOM from this bundle.
 *
 * The draft itself is read from `[data-composer-input]`, the editable surface
 * the composer already publishes, so no other plugin has to report it.
 */

import { ARMED_HINT, DICTIONARY, IDLE_PHRASE, NS, textOf } from './copy.ts';
import type { ClientPluginContext, LocaleService } from './types.ts';

/** The symbol this bundle claims. */
const SYMBOL = '!';

/** Upstream namespace owning the composer placeholder keys. */
const CONVERSATION_NS = 'conversation';

/** Placeholder keys that should carry the idle clause. */
const PLACEHOLDER_KEYS: ReadonlySet<string> = new Set([
  'placeholder.default',
  'placeholder.hero',
]);

/** Attribute upstream puts on the composer card. */
const CARD_ATTR = 'data-composer-card';

/** Attribute upstream puts on the editable surface. */
const INPUT_ATTR = 'data-composer-input';

/** The custom property upstream's hint rule reads. */
const HINT_PROPERTY = '--dsh-composer-hint';

/** Marker attribute recording what this bundle painted, for cheap clearing. */
const PAINTED_ATTR = 'data-dsh-hint-shell';

/** Zero-width characters Lexical may keep in an otherwise empty editor. */
const ZERO_WIDTH = /[\u200b\u200c\u200d\ufeff]/g;

/**
 * Log through one prefix so every line this bundle emits is greppable.
 *
 * @param level - console method to use
 * @param args - message parts
 */
function emit(level: 'info' | 'warn', ...args: readonly unknown[]): void {
  try {
    const method = console[level];
    if (typeof method === 'function') method.apply(console, ['[dsh-hint-shell]', ...args]);
  } catch {
    /* console may be proxied or unavailable */
  }
}

/**
 * Format a caught value for a log line.
 *
 * @param error - caught value
 * @returns a short description
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Append the idle clause to the composer placeholder, inside the translation
 * layer.
 *
 * Scoping to two exact keys in one exact namespace is what keeps this change as
 * small as the requirement; a wider patch would be indistinguishable from a
 * wholesale copy override.
 *
 * @param locale - the live locale service
 * @param clause - supplies the clause for the active language
 * @returns undo function
 */
function installPlaceholderClause(locale: LocaleService, clause: () => string): () => void {
  const holder = Object.getPrototypeOf(locale) as object | null;
  if (holder === null) {
    emit('warn', 'locale has no prototype; idle hint stays off');
    return () => {};
  }

  const descriptor = Object.getOwnPropertyDescriptor(holder, 'translate');
  if (descriptor === undefined || typeof descriptor.value !== 'function') {
    emit('warn', 'translate() not found on the locale prototype; idle hint stays off');
    return () => {};
  }

  const original = descriptor.value as (
    this: unknown,
    ns: string,
    key: string,
    params?: Record<string, string | number>,
  ) => string;

  try {
    Object.defineProperty(holder, 'translate', {
      ...descriptor,
      value: function patchedTranslate(
        this: unknown,
        ns: string,
        key: string,
        params?: Record<string, string | number>,
      ): string {
        const base = original.call(this, ns, key, params);
        if (ns !== CONVERSATION_NS || !PLACEHOLDER_KEYS.has(key)) return base;
        if (typeof base !== 'string' || base.length === 0) return base;

        const text = clause();
        if (text.length === 0) return base;
        // Never double up, even if this patch is installed twice.
        if (base.includes(text)) return base;
        return base + text;
      },
    });
  } catch (error) {
    emit('warn', 'cannot wrap translate:', describe(error));
    return () => {};
  }

  return () => {
    try {
      Object.defineProperty(holder, 'translate', descriptor);
    } catch (error) {
      emit('warn', 'cannot restore translate:', describe(error));
    }
  };
}

/**
 * Read a composer card's draft text.
 *
 * @param card - composer card element
 * @returns the draft, or null when the card has no editable surface yet
 */
function draftOf(card: HTMLElement): string | null {
  const input = card.querySelector<HTMLElement>(`[${INPUT_ATTR}]`);
  if (input === null) return null;
  // Lexical keeps a zero-width space in an otherwise empty editor.
  return (input.textContent ?? '').replace(ZERO_WIDTH, '');
}

/**
 * Whether this draft should show the armed hint.
 *
 * Only the bare symbol qualifies: once a command is being typed the hint has
 * done its job, and an empty composer uses the placeholder path instead.
 *
 * @param draft - draft text
 * @returns true when the hint belongs on screen
 */
function shouldHint(draft: string): boolean {
  return draft.trim() === SYMBOL;
}

/**
 * Paint or clear the hint on one card.
 *
 * The value is JSON-encoded exactly as upstream encodes it, so the CSS string
 * token stays balanced whatever text the dictionaries hold.
 *
 * The separating space belongs to the painted value, because `::after` renders
 * immediately after the typed glyph.
 *
 * @param card - composer card
 * @param hint - text to show, or null to clear
 */
function paint(card: HTMLElement, hint: string | null): void {
  const painted = card.getAttribute(PAINTED_ATTR);

  if (hint === null) {
    if (painted === null) return;
    card.removeAttribute(PAINTED_ATTR);
    card.style.removeProperty(HINT_PROPERTY);
    return;
  }

  if (painted === hint) return;
  card.setAttribute(PAINTED_ATTR, hint);
  card.style.setProperty(HINT_PROPERTY, JSON.stringify(` ${hint}`));
}

/**
 * Client plugin body.
 *
 * @param ctx - the Cordis client root context
 */
function apply(ctx: ClientPluginContext): void {
  const locale = ctx.locale;
  const t = locale.bind(NS);

  /**
   * Active language, narrowed to the two tags this bundle ships.
   *
   * @returns `en` for English locales, otherwise `zh`
   */
  const language = (): string => {
    try {
      return locale.getSnapshot().active.toLowerCase().startsWith('en') ? 'en' : 'zh';
    } catch {
      return 'zh';
    }
  };

  // Copy lives in this bundle's own namespace, so it can never collide.
  ctx.effect(() => locale.register(NS, DICTIONARY), 'dsh-hint-shell: register copy');

  // Idle hint: append the clause inside the placeholder translation.
  ctx.effect(
    () =>
      installPlaceholderClause(locale, () => {
        const tag = language();
        return textOf(t, 'idle', IDLE_PHRASE[tag] ?? IDLE_PHRASE['zh'] ?? '');
      }),
    'dsh-hint-shell: append idle clause to the composer placeholder',
  );

  /**
   * Repaint every composer card from the DOM.
   *
   * Only the card holding focus can be the one being typed into, so every other
   * card is cleared. Cards are found through the attribute the composer already
   * sets, and nothing is inserted into the DOM.
   */
  const repaint = (): void => {
    const tag = language();
    const hint = textOf(t, 'armed', ARMED_HINT[tag] ?? ARMED_HINT['zh'] ?? '');

    const cards = document.querySelectorAll<HTMLElement>(`[${CARD_ATTR}]`);
    for (const card of Array.from(cards)) {
      const draft = draftOf(card);
      const live = draft !== null && card.contains(document.activeElement) && shouldHint(draft);
      paint(card, live ? hint : null);
    }
  };

  ctx.effect(() => {
    /** Coalesce bursts of edits into one paint per frame. */
    let frame = 0;
    const schedule = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(repaint);
    };

    /**
     * Repaint shortly after the current task settles.
     *
     * The editable surface belongs to Lexical, which commits text into its own
     * paragraph nodes inside its update pass. That pass does not necessarily
     * finish before the browser dispatches `input`, so a synchronous read can
     * still describe the previous character. A deferred read covers the gap;
     * the MutationObserver below catches the commit itself, so this is only a
     * safety net for the ordering.
     */
    let settle = 0;
    const scheduleSettled = (): void => {
      schedule();
      clearTimeout(settle);
      settle = setTimeout(repaint, 0) as unknown as number;
    };

    // Typing, focus moves, and session switches all land on one of these.
    document.addEventListener('input', scheduleSettled, true);
    document.addEventListener('focusin', schedule, true);
    document.addEventListener('focusout', schedule, true);

    /**
     * Repaint when the editor commits text.
     *
     * This is the authoritative signal: it fires on the mutation Lexical makes
     * to its paragraph nodes, after the text is actually in the DOM, regardless
     * of how the browser ordered the event and the commit. Watching the whole
     * document is affordable because the observer only schedules a paint, and
     * character data outside the composer simply produces the same result.
     */
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // A locale switch changes the copy without any DOM event firing.
    const offLocale = locale.subscribe(schedule);

    schedule();

    return () => {
      offLocale();
      observer.disconnect();
      document.removeEventListener('input', scheduleSettled, true);
      document.removeEventListener('focusin', schedule, true);
      document.removeEventListener('focusout', schedule, true);
      cancelAnimationFrame(frame);
      clearTimeout(settle);
      for (const card of Array.from(document.querySelectorAll<HTMLElement>(`[${PAINTED_ATTR}]`))) {
        paint(card, null);
      }
    };
  }, 'dsh-hint-shell: repaint on draft change');

  emit('info', 'ready');
}

export const inject = ['locale'];
export { apply };
