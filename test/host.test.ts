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

import {
  formatOutcome,
  isFailed,
  parseShellLine,
  runShellLine,
  type ShellOutcome,
  type SubprocessLike,
} from '../src/exec.ts';

let checks = 0;
let failures = 0;

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
  });
  assert.match(text, /killed by SIGKILL/);
});
await check('reports truncation', () => {
  const text = formatOutcome({
    command: 'cat big',
    stdout: 'x',
    stderr: '',
    exitCode: 0,
    signal: null,
    truncated: true,
  });
  assert.match(text, /\[output truncated\]/);
});

console.log('\n[3] failure classification');

const ok: ShellOutcome = { command: 'ls', stdout: '', stderr: '', exitCode: 0, signal: null, truncated: false };
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

  assert.match(result!.data.message.content[0].text, /^\$ ls/);
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

console.log(failures === 0 ? `\nAll ${checks} checks passed.\n` : `\n${failures} of ${checks} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
