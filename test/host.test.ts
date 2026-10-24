/**
 * Tests for the `!` shell-line feature.
 *
 * Covers the pure parts (parsing, formatting, failure classification) and the
 * host hook end to end against a fake session and subprocess, which is where the
 * interesting contract lives: a `!` line must append a *paired* call/result and
 * must reject the step so no model request is dispatched.
 *
 * Run: node test/host.test.ts
 */

import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  formatOutcome,
  isFailed,
  parseShellLine,
  runShellLine,
  type ShellOutcome,
  type SubprocessLike,
} from '../src/exec.ts';
import {
  DEFAULT_MAX_COMMAND_CHARS,
  FALLBACK_TIMEOUT_MS,
  shellBudgetFrom,
  type Config,
} from '../src/config.ts';

let checks = 0;
let failures = 0;
let skipped = 0;

/**
 * Mark one check as skipped rather than silently passing it.
 *
 * @param reason - why the check could not run.
 */
function reportSkipped(reason: string): void {
  skipped += 1;
  console.log(`  skip (${reason})`);
}

/** Run one assertion group. */
async function check(label: string, body: () => void | Promise<void>): Promise<void> {
  checks += 1;
  try {
    await body();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}`);
    console.log(`       ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log('[1] parsing — the `!` is a prefix, not a separator');

await check('bare ! means ls', () => {
  assert.deepEqual(parseShellLine('!ls'), { command: 'ls' });
});
await check('! with a space means the same thing', () => {
  assert.deepEqual(parseShellLine('! ls'), { command: 'ls' });
});
await check('surrounding whitespace is ignored', () => {
  assert.deepEqual(parseShellLine('  !  git status  '), { command: 'git status' });
});
await check('a lone ! is prose, exactly like a lone /', () => {
  // The Harness bails on an empty trigger token (`parseCommand` returns
  // undefined for a bare `/`), so a bare `!` must not become a command either.
  assert.equal(parseShellLine('!'), undefined);
});
await check('a lone ! with trailing space is still prose', () => {
  assert.equal(parseShellLine('!   '), undefined);
});
await check('ordinary prose is not a shell line', () => {
  assert.equal(parseShellLine('hello'), undefined);
});
await check('a bang inside a sentence is not a shell line', () => {
  assert.equal(parseShellLine('hello world!'), undefined);
});
await check('a later ! does not make it a shell line', () => {
  assert.equal(parseShellLine('please run !ls'), undefined);
});

console.log('\n[2] formatting — the result must be self-describing');

await check('echoes the command and the exit status', () => {
  const text = formatOutcome({
    command: 'ls',
    stdout: 'a\nb\n',
    stderr: '',
    exitCode: 0,
    signal: null,
    truncated: false,
    spill: {},
  });
  assert.equal(text, '$ ls\na\nb\n[exit 0]');
});
await check('surfaces stderr separately', () => {
  const text = formatOutcome({
    command: 'ls nope',
    stdout: '',
    stderr: 'ls: nope: No such file or directory\n',
    exitCode: 1,
    signal: null,
    truncated: false,
    spill: {},
  });
  assert.match(text, /\[stderr\]/);
  assert.match(text, /No such file or directory/);
  assert.match(text, /\[exit 1\]/);
});
await check('reports a signal instead of an exit code', () => {
  const text = formatOutcome({
    command: 'sleep 100',
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: 'SIGKILL',
    truncated: false,
    spill: {},
  });
  assert.match(text, /killed by SIGKILL/);
});
await check('reports truncation and says the full stream is gone', () => {
  const text = formatOutcome({
    command: 'cat big',
    stdout: 'x',
    stderr: '',
    exitCode: 0,
    signal: null,
    truncated: true,
    spill: {},
  });
  assert.match(text, /\[output truncated; the full stream was too large to keep\]/);
});
await check('points at the spill file when the full stream survived', () => {
  const text = formatOutcome({
    command: 'cat big',
    stdout: 'x',
    stderr: '',
    exitCode: 0,
    signal: null,
    truncated: true,
    spill: { stdout: '/tmp/dsh-spill-abc' },
  });
  assert.match(text, /\[output truncated; full stream: \/tmp\/dsh-spill-abc\]/);
});
await check('names a timeout instead of an exit code', () => {
  const text = formatOutcome({
    command: 'sleep 100',
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
    timedOut: true,
    truncated: false,
    spill: {},
  });
  assert.match(text, /\[timed out and was terminated\]/);
});
await check('an over-long line echoes an elided command, not the whole thing', () => {
  const long = 'x'.repeat(12_000);
  const text = formatOutcome({
    command: long,
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
    rejectedTooLong: true,
    truncated: false,
    spill: {},
    failure: 'over the limit',
  });
  assert.equal(text.includes(long), false);
  assert.match(text, /12000 characters/);
});

console.log('\n[3] failure classification');

const ok: ShellOutcome = { command: 'ls', stdout: '', stderr: '', exitCode: 0, signal: null, truncated: false, spill: {} };
await check('exit 0 is success', () => {
  assert.equal(isFailed(ok), false);
});
await check('non-zero exit is failure', () => {
  assert.equal(isFailed({ ...ok, exitCode: 2 }), true);
});
await check('a signal is failure', () => {
  assert.equal(isFailed({ ...ok, signal: 'SIGTERM' }), true);
});
await check('a spawn failure is failure', () => {
  assert.equal(isFailed({ ...ok, failure: 'boom' }), true);
});

console.log('\n[4] execution — argv, cwd, and collected output');

/**
 * Locate an installed Harness checkout, for the checks that need a process the
 * plugin can actually kill.
 *
 * The provider is a composed Cordis service rather than an npm library, so it is
 * loaded from the installation. Without one, those checks report as skipped:
 * a fake spawn cannot prove that a timeout terminates anything.
 *
 * Everything here is derived at runtime. A pinned path would only ever be right
 * on the machine it was written on, and a miss silently downgrades the checks to
 * skips — which is precisely how they stop guarding anything.
 *
 * @returns the checkout root, or undefined when no installation is resolvable.
 */
function harnessCheckout(): string | undefined {
  const usable = (candidate: string | undefined): candidate is string =>
    candidate !== undefined
    && candidate.length > 0
    && existsSync(join(candidate, 'vendor/cordis/lib/index.js'));
  const explicit = [process.env.DSH_INSTALL, process.env.DSH].find(usable);
  if (explicit !== undefined) return explicit;
  // The launcher is a symlink into the installation prefix, and the workspace
  // sits at `<prefix>/lib/deepseek-harness-git`.
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue;
    let launcher: string;
    try {
      launcher = realpathSync(join(dir, 'dsh'));
    } catch {
      continue;
    }
    const checkout = join(dirname(dirname(launcher)), 'lib', 'deepseek-harness-git');
    if (usable(checkout)) return checkout;
  }
  return undefined;
}

/** The installation backing {@link realSubprocess}, when there is one. */
const checkout = harnessCheckout();

/** The real subprocess provider, or undefined when no installation is present. */
async function realSubprocess(): Promise<SubprocessLike | undefined> {
  if (checkout === undefined) return undefined;
  const { Context } = await import(pathToFileURL(join(checkout, 'vendor/cordis/lib/index.js')).href);
  const { default: LocalSubprocessRuntime } = await import(
    pathToFileURL(join(checkout, 'packages/subprocess/subprocess-local/lib/index.js')).href
  );
  const ctx = new Context();
  await ctx.plugin(LocalSubprocessRuntime);
  return ctx.get('subprocess') as SubprocessLike | undefined;
}

/** Build a subprocess double that records the spec it was given. */
function fakeSubprocess(reply: { stdout: string; stderr: string; exitCode: number | null; signal?: string | null }) {
  const seen: { spec?: Parameters<SubprocessLike['spawn']>[0] } = {};
  const service: SubprocessLike = {
    spawn(spec) {
      seen.spec = spec;
      return {
        collected: {
          stdout: { readFrom: () => ({ text: reply.stdout, nextOffset: reply.stdout.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: reply.stderr, nextOffset: reply.stderr.length, lossy: false }) },
        },
        done: Promise.resolve({ exitCode: reply.exitCode, signal: reply.signal ?? null }),
        terminate: () => {},
      };
    },
  };
  return { service, seen };
}

await check('runs the command through a shell so quoting works', async () => {
  const { service, seen } = fakeSubprocess({ stdout: 'hi', stderr: '', exitCode: 0 });
  const outcome = await runShellLine(service, { command: 'echo hi | tr a-z A-Z' }, '/tmp', new AbortController().signal);
  assert.equal(seen.spec?.argv[0], '/bin/sh');
  assert.equal(seen.spec?.argv[1], '-c');
  assert.equal(seen.spec?.argv[2], 'echo hi | tr a-z A-Z');
  assert.equal(seen.spec?.cwd, '/tmp');
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.stdout, 'hi');
});
await check('an empty command reports usage instead of spawning', async () => {
  const { service, seen } = fakeSubprocess({ stdout: '', stderr: '', exitCode: 0 });
  const outcome = await runShellLine(service, { command: '' }, '/tmp', new AbortController().signal);
  assert.equal(seen.spec, undefined);
  assert.match(outcome.failure ?? '', /no command given/);
});
await check('a spawn throw becomes a reported failure, not an exception', async () => {
  const service: SubprocessLike = {
    spawn() {
      throw new Error('spawn refused');
    },
  };
  const outcome = await runShellLine(service, { command: 'ls' }, '/tmp', new AbortController().signal);
  assert.match(outcome.failure ?? '', /spawn refused/);
});
await check('a rejected done becomes a reported failure, not an exception', async () => {
  // The seam documents `done` as rejecting for spawn/provider failures. That is a
  // command result, so it must not escape and lose the whole record.
  const service: SubprocessLike = {
    spawn() {
      return { collected: {}, done: Promise.reject(new Error('provider failed')), terminate: () => {} };
    },
  };
  const outcome = await runShellLine(service, { command: 'ls' }, '/tmp', new AbortController().signal);
  assert.match(outcome.failure ?? '', /provider failed/);
  assert.equal(outcome.stdout, '');
});
await check('a command over the length cap is refused before it spawns', async () => {
  // The cap is this plugin's one configurable limit; its default is what a
  // deployment that never edits it runs under, so the boundary is worth pinning.
  const { service, seen } = fakeSubprocess({ stdout: '', stderr: '', exitCode: 0 });
  const long = 'x'.repeat(DEFAULT_MAX_COMMAND_CHARS + 1);
  const outcome = await runShellLine(service, { command: long }, '/tmp', new AbortController().signal);
  assert.equal(seen.spec, undefined);
  assert.match(outcome.failure ?? '', new RegExp(`over the ${DEFAULT_MAX_COMMAND_CHARS}-character limit`));
  assert.equal(outcome.exitCode, null);
});
await check('a command exactly at the cap still runs', async () => {
  const { service, seen } = fakeSubprocess({ stdout: 'ok', stderr: '', exitCode: 0 });
  const atCap = 'y'.repeat(DEFAULT_MAX_COMMAND_CHARS);
  const outcome = await runShellLine(service, { command: atCap }, '/tmp', new AbortController().signal);
  assert.notEqual(seen.spec, undefined);
  assert.equal(outcome.failure, undefined);
  assert.equal(outcome.stdout, 'ok');
});
await check('a configured cap overrides the default', async () => {
  // The settings page writes into `maxCommandChars`; a live value must reach the
  // check, or editing it would appear to save and change nothing.
  const { service, seen } = fakeSubprocess({ stdout: 'ok', stderr: '', exitCode: 0 });
  const config = { maxCommandChars: { get: () => 5 } } as unknown as Config;
  const outcome = await runShellLine(service, { command: 'echo hi' }, '/tmp', new AbortController().signal, config);
  assert.equal(seen.spec, undefined);
  assert.match(outcome.failure ?? '', /over the 5-character limit/);
});
await check('the spec carries every field the seam requires', async () => {
  // `graceMs` is required and the seam applies no defaults, so dropping it would
  // make every spawn throw at validation time.
  const { service, seen } = fakeSubprocess({ stdout: '', stderr: '', exitCode: 0 });
  await runShellLine(service, { command: 'ls' }, '/tmp', new AbortController().signal);
  const spec = seen.spec!;
  assert.equal(typeof spec.graceMs, 'number');
  assert.equal(spec.stdio.stdin, 'ignore');
  assert.equal(typeof (spec.stdio.stdout as { maxBytes: number }).maxBytes, 'number');
  assert.equal(typeof (spec.stdio.stderr as { maxBytes: number }).maxBytes, 'number');
});

console.log('\n[4b] inherited shell budget — the terminal page owns these numbers');

await check('reads the timeout and output cap from bash-sandbox', async () => {
  const budget = shellBudgetFrom([
    { ns: 'bash-sandbox', value: { timeoutMs: 6_000, maxOutputBytes: 1_024 } },
  ]);
  assert.equal(budget.timeoutMs, 6_000);
  assert.equal(budget.maxOutputBytes, 1_024);
});
await check('falls back to pwsh-sandbox when bash-sandbox is absent', async () => {
  const budget = shellBudgetFrom([
    { ns: 'pwsh-sandbox', value: { timeoutMs: 7_000, maxOutputBytes: 2_048 } },
  ]);
  assert.equal(budget.timeoutMs, 7_000);
  assert.equal(budget.maxOutputBytes, 2_048);
});
await check('prefers bash-sandbox when both are served', async () => {
  const budget = shellBudgetFrom([
    { ns: 'pwsh-sandbox', value: { timeoutMs: 7_000 } },
    { ns: 'bash-sandbox', value: { timeoutMs: 6_000 } },
  ]);
  assert.equal(budget.timeoutMs, 6_000);
});
await check('an unread budget leaves both fields to the fallback', async () => {
  assert.deepEqual(shellBudgetFrom([]), {});
  assert.deepEqual(shellBudgetFrom([{ ns: 'other', value: { timeoutMs: 1 } }]), {});
});
await check('a zero or non-numeric value is dropped, not inherited', async () => {
  // A zero timeout would kill every command instantly, so it must not travel.
  const budget = shellBudgetFrom([
    { ns: 'bash-sandbox', value: { timeoutMs: 0, maxOutputBytes: 'big' } },
  ]);
  assert.equal(budget.timeoutMs, undefined);
  assert.equal(budget.maxOutputBytes, undefined);
});
await check('an inherited timeout actually bounds the command', async () => {
  // The regression this exists for: the terminal page's timeout was ignored
  // because the plugin hard-coded its own. `sleep 5` must die at 150ms.
  const subprocess = await realSubprocess();
  if (subprocess === undefined) return reportSkipped('no Harness installation');
  const started = Date.now();
  const outcome = await runShellLine(
    subprocess, { command: 'sleep 5' }, '/tmp',
    new AbortController().signal, undefined, { timeoutMs: 150 },
  );
  const elapsed = Date.now() - started;
  assert.equal(outcome.timedOut, true);
  assert.ok(elapsed < 3_000, `expected an early kill, waited ${elapsed}ms`);
});
await check('an unread budget uses the executor default, not a shorter one', async () => {
  // Without a readable budget the plugin must behave like a stock install; the
  // important half is that it does not fall back to some tiny value.
  const subprocess = await realSubprocess();
  if (subprocess === undefined) return reportSkipped('no Harness installation');
  const outcome = await runShellLine(subprocess, { command: 'echo ok' }, '/tmp', new AbortController().signal);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.failure, undefined);
  assert.ok(FALLBACK_TIMEOUT_MS >= 60_000, 'the fallback must not be shorter than a stock timeout');
});

console.log('\n[5] host hook — a valid v4 tool exchange, then reject');

/** Collect appends from a fake session. */
function fakeSession(surfaceNodes: readonly number[] = []) {
  const appended: Array<{ type: string; data: any; intent: any }> = [];
  return {
    appended,
    session: {
      // The live surface the plugin reads to decide whether the protected
      // system head already exists. Empty means "this session has no surface yet".
      surface: { nodes: surfaceNodes },
      // No `workingDirectory` field: the real Session has none either, and
      // faking one here hid a crash in cwd resolution. See the `[6]` checks.
      append(type: string, data: unknown, intent?: unknown) {
        appended.push({ type, data, intent });
        return { seq: appended.length };
      },
    },
  };
}

await check('a ! line appends a complete v4 tool exchange and rejects', async () => {
  const { appended, session } = fakeSession();
  const decisions: string[] = [];

  const hooks: Array<(payload: any, next: () => Promise<any>) => Promise<any>> = [];
  const ctx = {
    get: (name: string) => (name === 'subprocess' ? fakeSubprocess({ stdout: 'a b c', stderr: '', exitCode: 0 }).service : undefined),
    on(_name: string, listener: any) {
      hooks.push(listener);
    },
  };

  const { apply } = await import('../host.ts');
  apply(ctx as any);

  const next = async () => {
    decisions.push('next');
    return { kind: 'enter', messages: [] };
  };

  const decision = await hooks[0]!(
    {
      agent: { id: 's1', session },
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '!ls' }] }],
      turn: 3,
      step: 1,
      signal: new AbortController().signal,
    },
    next,
  );

  assert.equal(decision.kind, 'reject');
  assert.deepEqual(decisions, []);

  // A surface message needs an open step (pre-step runs before the loop opens
  // its own), and the protected system head must exist before the first real
  // system/message can be appended, so a fresh surface gets an empty head.
  assert.deepEqual(appended.map((entry) => entry.type), [
    'step/start',
    'system/message',
    'assistant/message',
    'tool/call',
    'tool/result',
    'step/end',
  ]);

  assert.deepEqual(appended[0]!.data, { turn: 3, step: 1 });
  assert.equal(appended[0]!.intent, undefined);
  assert.deepEqual(appended[5]!.data, { turn: 3, step: 1 });

  const head = appended[1]!;
  assert.equal(head.data.turn, 3);
  assert.equal(head.data.step, 1);
  assert.equal(typeof head.data.message.id, 'string');
  assert.equal(head.data.message.role, 'system');
  assert.deepEqual(head.data.message.content, []);
  assert.deepEqual(head.data.message.source, { kind: 'system-prompt' });
  assert.deepEqual(head.intent, { surfaceOp: 'append' });

  const [assistant, call, result] = appended.slice(2);
  const callBlock = assistant!.data.message.content[0];
  assert.equal(callBlock.type, 'tool-call');
  assert.equal(callBlock.name, 'shell');
  // v4 requires a first-class, identified assistant message, and the source
  // must be a producer-owned kind (a bare `{ provider, model }` is not enough).
  assert.equal(typeof assistant!.data.message.id, 'string');
  assert.equal(assistant!.data.message.source.kind, 'model');
  assert.equal(assistant!.data.message.source.provider, 'dsh-hint-shell');
  assert.deepEqual(assistant!.intent, { surfaceOp: 'append' });

  // The records must agree on the call id, or the provider rejects them.
  assert.equal(call!.data.callId, callBlock.id);
  assert.equal(result!.data.message.toolCallId, callBlock.id);
  assert.equal(result!.data.message.role, 'tool');
  assert.equal(typeof result!.data.message.id, 'string');
  // v4 reconciles the message source's callId with toolCallId, and the UI pairs
  // a result with its call through the source.
  assert.deepEqual(result!.data.message.source, { kind: 'tool', callId: callBlock.id });
  assert.deepEqual(result!.intent, { surfaceOp: 'append', sourceEventSeqs: [4] });
  assert.equal(call!.intent, undefined);

  // The result opens with its provenance: the wire carries no message source,
  // so this line is the only cue that the user, not the model, ran the command.
  assert.match(result!.data.message.content[0].text, /^\[run by the user via `!` prompt symbol\]\n/);
  assert.match(result!.data.message.content[0].text, /\$ ls/);
  assert.match(result!.data.message.content[0].text, /a b c/);
  assert.equal(result!.data.message.isError, false);
});

await check('a session that already has a surface keeps its own head', async () => {
  // The loop's first system/message is the protected head. Once any surface
  // exists, seeding another one would be noise (and would render as an extra
  // system-prompt node), so only an empty surface gets one.
  const { appended, session } = fakeSession([0]);
  const hooks: Array<(payload: any, next: () => Promise<any>) => Promise<any>> = [];
  const { apply } = await import('../host.ts');
  apply({
    get: (name: string) => (name === 'subprocess' ? fakeSubprocess({ stdout: 'ok', stderr: '', exitCode: 0 }).service : undefined),
    on: (_n: string, l: any) => hooks.push(l),
  } as any);

  const decision = await hooks[0]!(
    {
      agent: { id: 's1', session },
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '!ls' }] }],
      turn: 2,
      step: 1,
      signal: new AbortController().signal,
    },
    async () => ({ kind: 'enter', messages: [] }),
  );

  assert.equal(decision.kind, 'reject');
  assert.deepEqual(appended.map((entry) => entry.type), [
    'step/start',
    'assistant/message',
    'tool/call',
    'tool/result',
    'step/end',
  ]);
  assert.equal(appended.filter((entry) => entry.type === 'system/message').length, 0);
});

await check('ordinary prose passes through untouched', async () => {
  const { appended, session } = fakeSession();
  const hooks: Array<(payload: any, next: () => Promise<any>) => Promise<any>> = [];
  const { apply } = await import('../host.ts');
  apply({ get: () => undefined, on: (_n: string, l: any) => hooks.push(l) } as any);

  const decision = await hooks[0]!(
    {
      agent: { id: 's1', session },
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    },
    async () => ({ kind: 'enter', messages: [] }),
  );

  assert.equal(decision.kind, 'enter');
  assert.deepEqual(appended, []);
});

await check('a lone ! is sent to the model like any other text', async () => {
  const { appended, session } = fakeSession();
  const hooks: Array<(payload: any, next: () => Promise<any>) => Promise<any>> = [];
  const { apply } = await import('../host.ts');
  apply({ get: (name: string) => (name === 'subprocess' ? fakeSubprocess({ stdout: '', stderr: '', exitCode: 0 }).service : undefined), on: (_n: string, l: any) => hooks.push(l) } as any);

  const decision = await hooks[0]!(
    {
      agent: { id: 's1', session },
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '!' }] }],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    },
    async () => ({ kind: 'enter', messages: [] }),
  );

  // Matches the Harness' own trigger convention: an empty token is not a command.
  assert.equal(decision.kind, 'enter');
  assert.deepEqual(appended, []);
});

await check('injected context is never executed, even when it starts with !', async () => {
  // The loop delivers `runtime-context` and `time-context` snapshots under the
  // user role. Treating one as a command would run harness-owned text.
  const { appended, session } = fakeSession();
  const hooks: Array<(payload: any, next: () => Promise<any>) => Promise<any>> = [];
  const { apply } = await import('../host.ts');
  apply({ get: (name: string) => (name === 'subprocess' ? fakeSubprocess({ stdout: 'x', stderr: '', exitCode: 0 }).service : undefined), on: (_n: string, l: any) => hooks.push(l) } as any);

  const decision = await hooks[0]!(
    {
      agent: { id: 's1', session },
      messages: [
        { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '!rm -rf /' }] },
      ],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    },
    async () => ({ kind: 'enter', messages: [] }),
  );

  assert.equal(decision.kind, 'enter');
  assert.deepEqual(appended, []);
});

await check('the newest human message decides, not an older one', async () => {
  // An earlier `!` line was already handled on its own turn; re-running it from
  // history would repeat a command the user did not ask for again.
  const { appended, session } = fakeSession();
  const hooks: Array<(payload: any, next: () => Promise<any>) => Promise<any>> = [];
  const { apply } = await import('../host.ts');
  apply({ get: (name: string) => (name === 'subprocess' ? fakeSubprocess({ stdout: '', stderr: '', exitCode: 0 }).service : undefined), on: (_n: string, l: any) => hooks.push(l) } as any);

  const decision = await hooks[0]!(
    {
      agent: { id: 's1', session },
      messages: [
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '!ls' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'now do something else' }] },
      ],
      turn: 2,
      step: 1,
      signal: new AbortController().signal,
    },
    async () => ({ kind: 'enter', messages: [] }),
  );

  assert.equal(decision.kind, 'enter');
  assert.deepEqual(appended, []);
});

await check('a failing command is marked isError', async () => {
  const { appended, session } = fakeSession();
  const hooks: Array<(payload: any, next: () => Promise<any>) => Promise<any>> = [];
  const { apply } = await import('../host.ts');
  apply({ get: (name: string) => (name === 'subprocess' ? fakeSubprocess({ stdout: '', stderr: 'boom', exitCode: 1 }).service : undefined), on: (_n: string, l: any) => hooks.push(l) } as any);

  await hooks[0]!(
    {
      agent: { id: 's1', session },
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '!nope' }] }],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    },
    async () => ({ kind: 'enter', messages: [] }),
  );

  const result = appended.find((entry) => entry.type === 'tool/result');
  assert.equal(result!.data.message.isError, true);
});

await check('a refused append fails the turn instead of faking success', async () => {
  // The original bug: a record() failure was caught and the step was rejected
  // anyway, so the turn looked successful while nothing had run or been logged.
  // Now a refused append propagates: the loop ends the turn with the real error.
  const hooks: Array<(payload: any, next: () => Promise<any>) => Promise<any>> = [];
  const { apply } = await import('../host.ts');
  apply({
    get: (name: string) => (name === 'subprocess' ? fakeSubprocess({ stdout: 'ok', stderr: '', exitCode: 0 }).service : undefined),
    on: (_n: string, l: any) => hooks.push(l),
  } as any);

  let entered = false;
  const session = {
    surface: { nodes: [] as number[] },
    append() {
      throw new Error('append refused');
    },
  };

  await assert.rejects(
    hooks[0]!(
      {
        agent: { id: 's1', session },
        messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '!ls' }] }],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      },
      async () => {
        entered = true;
        return { kind: 'enter', messages: [] };
      },
    ),
    /append refused/,
  );
  assert.equal(entered, false);
});

await check('a failure inside the pair still closes the synthetic step', async () => {
  // If an append after `step/start` refuses, the step must still be closed or
  // the loop's own `turn/end` would be illegal (and the session unreadable).
  const appended: string[] = [];
  let appends = 0;
  const session = {
    surface: { nodes: [] as number[] },
    append(type: string) {
      appends += 1;
      if (appends === 4) throw new Error('tool call append refused');
      appended.push(type);
      return { seq: appends };
    },
  };

  const hooks: Array<(payload: any, next: () => Promise<any>) => Promise<any>> = [];
  const { apply } = await import('../host.ts');
  apply({
    get: (name: string) => (name === 'subprocess' ? fakeSubprocess({ stdout: 'ok', stderr: '', exitCode: 0 }).service : undefined),
    on: (_n: string, l: any) => hooks.push(l),
  } as any);

  await assert.rejects(
    hooks[0]!(
      {
        agent: { id: 's1', session },
        messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '!ls' }] }],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      },
      async () => ({ kind: 'enter', messages: [] }),
    ),
    /tool call append refused/,
  );

  assert.deepEqual(appended, ['step/start', 'system/message', 'assistant/message', 'step/end']);
});

console.log('[6] cwd — resolved through ctx.get, never through a service property');

await check('the directory comes from the composed service, read via ctx.get', async () => {
  const { appended, session } = fakeSession();
  const { service, seen } = fakeSubprocess({ stdout: 'ok', stderr: '', exitCode: 0 });
  const hooks: Array<(payload: any, next: () => Promise<any>) => Promise<any>> = [];

  // cordis throws when a plugin reads a service it never declared in `inject`,
  // and this plugin deliberately injects nothing. Reproduce that here so a
  // regression to `ctx.workingDirectory` fails the test the way the host fails,
  // instead of silently reading `undefined` off a plain object.
  const base = {
    get(name: string) {
      if (name === 'subprocess') return service;
      if (name === 'workingDirectory') return { get: () => '/home/project' };
      return undefined;
    },
    on(_n: string, l: any) {
      hooks.push(l);
    },
  };
  const cordisLike = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'workingDirectory') {
        throw new Error('cannot get property "workingDirectory" without inject');
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const { apply } = await import('../host.ts');
  apply(cordisLike as any);

  const decision = await hooks[0]!(
    {
      agent: { id: 's1', session },
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '!ls' }] }],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    },
    async () => ({ kind: 'enter', messages: [] }),
  );

  assert.equal(decision.kind, 'reject');
  assert.equal(seen.spec?.cwd, '/home/project');
  assert.deepEqual(appended.map((entry) => entry.type), [
    'step/start',
    'system/message',
    'assistant/message',
    'tool/call',
    'tool/result',
    'step/end',
  ]);
});

await check('falls back to process.cwd() when no working-directory provider is composed', async () => {
  const { appended, session } = fakeSession();
  const { service, seen } = fakeSubprocess({ stdout: '', stderr: '', exitCode: 0 });
  const hooks: Array<(payload: any, next: () => Promise<any>) => Promise<any>> = [];

  const { apply } = await import('../host.ts');
  apply({
    get: (name: string) => (name === 'subprocess' ? service : undefined),
    on: (_n: string, l: any) => hooks.push(l),
  } as any);

  const decision = await hooks[0]!(
    {
      agent: { id: 's1', session },
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '!pwd' }] }],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    },
    async () => ({ kind: 'enter', messages: [] }),
  );

  assert.equal(decision.kind, 'reject');
  assert.equal(seen.spec?.cwd, process.cwd());
  assert.equal(appended.filter((entry) => entry.type === 'tool/result').length, 1);
});

const skippedNote = skipped === 0 ? '' : ` (${skipped} skipped)`;
console.log(failures === 0
  ? `\nAll ${checks} checks passed${skippedNote}.\n`
  : `\n${failures} of ${checks} check(s) failed${skippedNote}.\n`);
process.exit(failures === 0 ? 0 : 1);
