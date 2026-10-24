/**
 * Integration test for dsh-hint-shell.
 *
 * Runs the real `src/` sources against a minimal fake DOM and a fake locale
 * service, so both effects are asserted as behaviour rather than eyeballed:
 *
 *   1. the placeholder translation gains the idle clause, and only for the two
 *      composer keys in the `conversation` namespace;
 *   2. the armed hint is painted from the draft, and only while the draft is
 *      the bare symbol.
 *
 * Usage: node test/run.test.ts
 */

import assert from 'node:assert/strict';

import { apply, inject } from '../src/index.ts';

// ── fake DOM ───────────────────────────────────────────────────────────────

/** One composable test card. */
class FakeElement {
  attributes = new Map<string, string>();
  style = {
    values: new Map<string, string>(),
    setProperty: (name: string, value: string): void => {
      fakeStyleValues.set(name, value);
    },
    removeProperty: (name: string): void => {
      fakeStyleValues.delete(name);
    },
  };
  children: FakeElement[] = [];
  textContent = '';

  constructor(name: string) {
    this.name = name;
  }

  name: string;

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  contains(other: unknown): boolean {
    return other === this || this.children.includes(other as FakeElement);
  }

  querySelector(selector: string): FakeElement | null {
    const attr = selector.slice(1, -1);
    if (this.attributes.has(attr)) return this;
    for (const child of this.children) {
      const hit = child.querySelector(selector);
      if (hit !== null) return hit;
    }
    return null;
  }
}

/** Style writes land here, since the fake elements share one map. */
const fakeStyleValues = new Map<string, string>();

/** Every card the fake document knows about. */
let cards: FakeElement[] = [];

/** Simulated focus target. */
let focused: unknown = null;

/** Registered document listeners. */
const listeners = new Map<string, Set<() => void>>();

const fakeDocument = {
  querySelectorAll(selector: string): FakeElement[] {
    const attr = selector.slice(1, -1);
    return cards.filter((card) => card.attributes.has(attr));
  },
  addEventListener(type: string, listener: () => void): void {
    const set = listeners.get(type) ?? new Set();
    set.add(listener);
    listeners.set(type, set);
  },
  removeEventListener(type: string, listener: () => void): void {
    listeners.get(type)?.delete(listener);
  },
  get activeElement(): unknown {
    return focused;
  },
};

/** Fire a fake DOM event at every registered listener. */
function fire(type: string): void {
  for (const listener of Array.from(listeners.get(type) ?? [])) listener();
}

/**
 * Build a composer card containing an editable surface.
 *
 * @param draft - text the editable surface reports
 */
function makeCard(draft: string): { card: FakeElement; input: FakeElement } {
  const card = new FakeElement(`card:${draft}`);
  card.setAttribute('data-composer-card', '');
  const input = new FakeElement(`input:${draft}`);
  input.setAttribute('data-composer-input', '');
  input.textContent = draft;
  card.children.push(input);
  return { card, input };
}

/** Observers created by the plugin, so the test can drive commits explicitly. */
const observers: Array<{ callback: () => void; active: boolean }> = [];

/** Minimal MutationObserver stand-in: records callbacks and can be fired. */
class FakeMutationObserver {
  private readonly record: { callback: () => void; active: boolean };

  constructor(callback: () => void) {
    this.record = { callback, active: true };
    observers.push(this.record);
  }

  observe(): void {
    /* targets are irrelevant to this fixture */
  }

  disconnect(): void {
    this.record.active = false;
  }
}

Object.assign(globalThis, {
  document: fakeDocument,
  MutationObserver: FakeMutationObserver,
  requestAnimationFrame: (fn: () => void): number => {
    fn();
    return 1;
  },
  cancelAnimationFrame: (): void => {},
});

/** Deliver a DOM commit to every live observer, as Lexical's write would. */
function commitDom(): void {
  for (const observer of observers) {
    if (observer.active) observer.callback();
  }
}

// ── fake locale service ────────────────────────────────────────────────────

/** Mirrors the real runtime: dictionaries keyed by namespace, then locale. */
class FakeLocale {
  dicts = new Map<string, Map<string, Record<string, string>>>();
  active = 'zh';
  private readonly subscriptions = new Set<() => void>();

  register(ns: string, input: unknown, dict?: Record<string, string>): () => void {
    const pairs: Array<[string, Record<string, string>]> =
      typeof input === 'string'
        ? [[input, dict ?? {}]]
        : Object.entries(input as Record<string, Record<string, string>>);

    let locales = this.dicts.get(ns);
    if (locales === undefined) {
      locales = new Map();
      this.dicts.set(ns, locales);
    }
    for (const [locale] of pairs) {
      if (locales.has(locale)) {
        throw new Error(`locale namespace "${ns}" already has locale "${locale}"`);
      }
    }
    for (const [locale, entries] of pairs) locales.set(locale, entries);
    this.publish();
    return () => {};
  }

  bind(ns: string): (key: string) => string {
    return (key) => this.translate(ns, key);
  }

  translate(ns: string, key: string, params?: Record<string, string | number>): string {
    const template = this.lookup(ns, key) ?? (ns !== 'common' ? this.lookup('common', key) : undefined) ?? key;
    if (params === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
      name in params ? String(params[name]) : _match,
    );
  }

  lookup(ns: string, key: string): string | undefined {
    const locales = this.dicts.get(ns);
    if (locales === undefined) return undefined;
    // Mirror the real runtime: try the full tag, then the primary subtag.
    const exact = locales.get(this.active)?.[key];
    if (exact !== undefined) return exact;
    return locales.get(this.active.split('-')[0] ?? '')?.[key];
  }

  getSnapshot(): { active: string } {
    return { active: this.active };
  }

  subscribe(listener: () => void): () => void {
    this.subscriptions.add(listener);
    return () => this.subscriptions.delete(listener);
  }

  publish(): void {
    for (const listener of Array.from(this.subscriptions)) listener();
  }
}

// ── harness ────────────────────────────────────────────────────────────────

/** Collect effects so teardown can be exercised. */
const teardowns: Array<() => void> = [];

const locale = new FakeLocale();
// Seed the shipped dictionaries the plugin is expected to cooperate with.
// The annotation is what keeps the two dictionaries one type: without it
// TypeScript infers a union of two object shapes, and a union whose members
// differ in optional keys does not satisfy the `Record<string, string>` the
// fake locale stores — `zh` has `placeholder.parentOffline`, `en` does not.
const conversationZh: Record<string, string> = {
  'placeholder.default': '发消息或创建任务, / 调用指令, @ 文件或对话',
  'placeholder.hero': '描述你想要构建的内容, / 调用指令, @ 文件或对话',
  'placeholder.parentOffline': '会话已离线',
};
const conversationEn: Record<string, string> = {
  'placeholder.default': 'Message or run a task, / commands, @ files or sessions',
  'placeholder.hero': 'Describe what you want to build, / commands, @ files or sessions',
};
locale.dicts.set(
  'conversation',
  new Map([
    ['zh', conversationZh],
    ['en', conversationEn],
  ]),
);

const ctx = {
  locale,
  effect(callback: () => () => void): void {
    teardowns.push(callback());
  },
};

apply(ctx as never);

// ── assertions ─────────────────────────────────────────────────────────────

let failures = 0;

/**
 * Assert one property and report it.
 *
 * @param label - what is being checked
 * @param fn - assertion body
 */
function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}`);
    console.log(`       ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log('\n[1] idle hint — placeholder translation');
check('declares locale injection', () => assert.deepEqual(inject, ['locale']));
check('appends clause to placeholder.default (zh)', () => {
  const value = locale.translate('conversation', 'placeholder.default');
  assert.equal(value, '发消息或创建任务, / 调用指令, @ 文件或对话，输入 ! 执行 shell 命令');
});
check('appends clause to placeholder.hero (zh)', () => {
  const value = locale.translate('conversation', 'placeholder.hero');
  assert.equal(value, '描述你想要构建的内容, / 调用指令, @ 文件或对话，输入 ! 执行 shell 命令');
});
check('leaves other conversation keys alone', () => {
  assert.equal(locale.translate('conversation', 'placeholder.parentOffline'), '会话已离线');
});
check('leaves other namespaces alone', () => {
  // This namespace is the plugin's own, so its own keys must resolve verbatim —
  // patching the placeholder must not rewrite copy the plugin owns for other
  // surfaces (the settings page reads the same dictionary).
  assert.equal(locale.translate('dsh-hint-shell', 'idle'), '，输入 ! 执行 shell 命令');
  assert.equal(locale.translate('dsh-hint-shell', 'armed'), '输入 shell 命令…');
});
check('does not double-append on repeat lookup', () => {
  const first = locale.translate('conversation', 'placeholder.default');
  const second = locale.translate('conversation', 'placeholder.default');
  assert.equal(second, first);
});
check('switches with the active locale', () => {
  locale.active = 'en';
  assert.equal(
    locale.translate('conversation', 'placeholder.default'),
    'Message or run a task, / commands, @ files or sessions, type ! for shell commands',
  );
  locale.active = 'zh';
});

console.log('\n[2] armed hint — painted from the draft');
const empty = makeCard('\u200b');
const armed = makeCard('!');
const typing = makeCard('!ls -la');
const prose = makeCard('hello');
cards = [empty.card, armed.card, typing.card, prose.card];

check('paints the hint when the draft is bare !', () => {
  focused = armed.input;
  fire('focusin');
  assert.equal(
    fakeStyleValues.get('--dsh-composer-hint'),
    JSON.stringify(' 输入 shell 命令…'),
  );
  assert.equal(armed.card.getAttribute('data-dsh-hint-shell'), '输入 shell 命令…');
});
check('clears the hint once a command is typed', () => {
  focused = typing.input;
  fire('input');
  assert.equal(typing.card.getAttribute('data-dsh-hint-shell'), null);
});
check('never paints on an empty composer', () => {
  focused = empty.input;
  fire('focusin');
  assert.equal(empty.card.getAttribute('data-dsh-hint-shell'), null);
});
check('never paints on ordinary prose', () => {
  focused = prose.input;
  fire('focusin');
  assert.equal(prose.card.getAttribute('data-dsh-hint-shell'), null);
});
check('paints in English when the locale is English', () => {
  locale.active = 'en';
  focused = armed.input;
  fire('focusin');
  assert.equal(
    armed.card.getAttribute('data-dsh-hint-shell'),
    'Enter a shell command…',
  );
  locale.active = 'zh';
});

console.log('\n[2b] commit timing — Lexical writes the DOM after the input event');
const late = makeCard('');
await (async () => {
  // A fresh card whose committed text lags one tick behind the browser's
  // native `input` event, exactly as the Lexical-owned surface behaves: the
  // event fires, then the editor commits its paragraph nodes.
  cards = [late.card];
  let committed = '';
  Object.defineProperty(late.input, 'textContent', {
    get: () => committed,
    configurable: true,
  });

  focused = late.input;

  // Keystroke 1: the input event fires while the surface still reads empty.
  fire('input');
  // The editor then commits the character into its paragraph nodes and the
  // browser reports the DOM mutation — this is the authoritative signal.
  committed = '!';
  commitDom();

  try {
    assert.equal(late.card.getAttribute('data-dsh-hint-shell'), '输入 shell 命令…');
    console.log('  ok   paints on the first keystroke despite a late DOM commit');
  } catch (error) {
    failures += 1;
    console.log('  FAIL paints on the first keystroke despite a late DOM commit');
    console.log(`       ${error instanceof Error ? error.message : String(error)}`);
  }

  // Typing a command must still clear it, with the same lag.
  fire('input');
  committed = '!ls';
  commitDom();
  try {
    assert.equal(late.card.getAttribute('data-dsh-hint-shell'), null);
    console.log('  ok   still clears once a command is typed, with the same lag');
  } catch (error) {
    failures += 1;
    console.log('  FAIL still clears once a command is typed, with the same lag');
    console.log(`       ${error instanceof Error ? error.message : String(error)}`);
  }
})();

console.log('\n[3] teardown');
check('removes listeners and unpaints', () => {
  // The fake document only reports cards currently in `cards`, so restore the
  // full set first: teardown must clear every card it ever painted, including
  // ones that left the render tree.
  cards = [empty.card, armed.card, typing.card, prose.card, late.card];
  for (const teardown of teardowns) teardown();
  assert.equal(listeners.get('input')?.size ?? 0, 0);
  assert.equal(armed.card.getAttribute('data-dsh-hint-shell'), null);
});
check('restores the original translate', () => {
  assert.equal(
    locale.translate('conversation', 'placeholder.default'),
    '发消息或创建任务, / 调用指令, @ 文件或对话',
  );
});

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
