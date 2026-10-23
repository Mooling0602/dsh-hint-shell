/**
 * Integration test against an installed DeepSeek Harness.
 *
 * The unit tests use a fake session, which cannot catch a record shape that the
 * *real* format v4 reader rejects. That is exactly the bug this file guards:
 * the plugin used to append an assistant/tool pair whose messages had no ids and
 * whose tool source had no `callId`, so the log was accepted live but failed to
 * re-open with `format v4 tool/result at seq 8 requires a first-class message
 * with a string id` — and the failed persistence write surfaced as a turn error.
 *
 * This test drives the shipped `apply()` hook against a real `Session` (so the
 * append-time surface rules run), then validates the resulting log through the
 * real v4 encoder, row admission, and session restorer, and finally re-derives
 * the model-visible history.
 *
 * The harness packages are resolved from the host installation, never from a
 * local dependency: a plugin ships without them. When no installation can be
 * found the file reports that it skipped instead of failing an unrelated build.
 *
 * Run: node test/dsh-format.test.ts
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

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

/**
 * Locate the `@deepseek-ai/*` packages an installed Harness resolves.
 *
 * @returns the directory containing them, or undefined when none is installed.
 */
function installedModules(): string | undefined {
  const roots: string[] = [];
  const override = process.env.DSH_MODULES;
  if (override !== undefined && override.length > 0) roots.push(override);
  try {
    const root = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (root.length > 0) roots.push(root);
  } catch {
    // No global npm root: the override or the skip below decides.
  }
  for (const root of roots) {
    const modules = join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai');
    if (existsSync(join(modules, 'dsh-session', 'package.json'))) return modules;
  }
  return undefined;
}

const modules = installedModules();
if (modules === undefined) {
  console.log('\n[7] installed Harness — SKIPPED (no @deepseek-ai/dsh installation found;');
  console.log('    set DSH_MODULES to the global node_modules directory to run it)');
  process.exit(0);
}

const load = (relative: string) => import(pathToFileURL(join(modules, relative)).href);

const sessionModule: any = await load('dsh-session/lib/index.js');
const formatModule: any = await load('dsh-session-format-v3-to-v4/lib/index.js');
const catalogModule: any = await load('dsh-session-format-catalog/lib/index.js');

const { Session, SessionId, SessionLogOffset, KNOWN_SESSION_EVENT_TYPES } = sessionModule;
const { releasedV4SessionFormatCodec, assertV4RowAdmission } = formatModule;
const { sessionFormatCatalog } = catalogModule;

const { apply } = await import('../host.ts');

/** Header for a throwaway session in the current directory. */
function header(): any {
  return {
    version: 4,
    id: `session-hint-shell-${randomUUID()}`,
    createdAt: Date.now(),
    isSeeded: false,
    delegationDepth: 0,
    cwd: process.cwd(),
  };
}

/** A subprocess double that answers every command with fixed output. */
function fakeSubprocess(stdout: string, exitCode = 0): any {
  return {
    spawn() {
      return {
        collected: {
          stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done: Promise.resolve({ exitCode, signal: null }),
        terminate() {},
      };
    },
  };
}

/** Capture the plugin's pre-step listener and drive it once. */
async function runHook(session: any, turn: number, step: number, text: string, stdout = 'ok\n', exitCode = 0): Promise<any> {
  const hooks: Array<(payload: any, next: () => Promise<any>) => Promise<any>> = [];
  apply({
    on(_name: string, listener: any) {
      hooks.push(listener);
    },
    get(name: string) {
      if (name === 'workingDirectory') return { get: () => process.cwd() };
      if (name === 'subprocess') return fakeSubprocess(stdout, exitCode);
      return undefined;
    },
  } as any);
  return hooks[0]!(
    {
      agent: { id: session.id, session },
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }],
      turn,
      step,
      signal: new AbortController().signal,
    },
    async () => ({ kind: 'enter', messages: [] }),
  );
}

/** Append the loop's opening events for a turn whose inbox holds one message. */
function openTurn(session: any, turn: number, text: string): void {
  session.append('agent/inbox/spliced', {
    target: 'next-turn',
    start: 0,
    inserted: [{
      content: [{ type: 'text', text }],
      source: { kind: 'user', rpcId: `rpc-${turn}`, clientTimeZone: 'Asia/Shanghai' },
      role: 'user',
      id: randomUUID(),
    }],
  });
  session.append('turn/start', { turn });
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
}

/** Append one ordinary model turn, exactly as the loop writes it. */
function modelTurn(session: any, turn: number, prompt: string, question: string, answer: string): void {
  openTurn(session, turn, question);
  session.append('step/start', { turn, step: 1 });
  session.append('system/message', {
    turn,
    step: 1,
    message: {
      id: randomUUID(),
      role: 'system',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'system-prompt' },
    },
  }, { surfaceOp: 'append' });
  session.append('user/message', {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: question }],
    source: { kind: 'user', rpcId: `rpc-${turn}-user`, clientTimeZone: 'Asia/Shanghai' },
  }, { surfaceOp: 'append' });
  session.append('assistant/message', {
    turn,
    step: 1,
    message: {
      id: randomUUID(),
      role: 'assistant',
      content: [{ type: 'text', text: answer }],
      source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' },
    },
    stream: [],
  }, { surfaceOp: 'append' });
  session.append('step/end', { turn, step: 1 });
  session.append('turn/end', { turn, reason: { kind: 'completed' } });
}

/**
 * Re-open a log the way startup does: encode each physical row, admit it, read
 * it through the format catalog, and restore the Session.
 *
 * @param session - live session whose committed log is validated.
 * @returns the restored session and its model-visible history.
 */
function reopen(session: any) {
  const events: any[] = session.snapshotEvents();
  const meta = { type: 'session', ...session.header };
  const restore = sessionFormatCatalog.createRestore(meta, { recovery: 'strict', validation: 'current' });
  for (const event of events) {
    const row = JSON.parse(JSON.stringify(releasedV4SessionFormatCodec.encodeEvent(event)));
    assertV4RowAdmission(row, KNOWN_SESSION_EVENT_TYPES);
    restore.decodeRow(row);
  }
  const artifact = restore.finish();
  const restored = Session.fromRestore(
    SessionId(artifact.header.id),
    artifact.events,
    artifact.header,
    SessionLogOffset(artifact.inheritedEventCount),
    'detached',
  );
  const history = restored.surface.nodes
    .map((seq: number) => restored.eventAt(seq))
    .map((event: any) => restored.deriveEventMessage(event))
    .filter((message: any) => message !== null);
  return { restored, history, events };
}

/** Create a real session in the same shape the store gives a brand-new chat. */
function freshSession() {
  const meta = header();
  const session = Session.create(SessionId(meta.id), undefined, meta);
  session.append('permission/preset', { preset: 'workspace-write' });
  session.append('sandbox/mode', { mode: 'workspace-write' });
  session.append('approval/policy', { policy: 'ask' });
  return { session, meta };
}

console.log('\n[7] installed Harness — the recorded pair must survive a real reopen');

await check('a ! line as the first turn produces a log the real reader accepts', async () => {
  const { session } = freshSession();
  openTurn(session, 1, '!uname -r');

  const decision = await runHook(session, 1, 1, '!uname -r', '5.10.252-gki-xaga/d113f161\n');
  assert.equal(decision.kind, 'reject');
  session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } });

  const types = session.snapshotEvents().map((event: any) => event.type);
  assert.deepEqual(types, [
    'permission/preset',
    'sandbox/mode',
    'approval/policy',
    'agent/inbox/spliced',
    'turn/start',
    'agent/inbox/spliced',
    'step/start',
    'system/message',
    'assistant/message',
    'tool/call',
    'tool/result',
    'step/end',
    'turn/end',
  ]);

  const { history } = reopen(session);
  const toolIndex = history.findIndex((message: any) => message.role === 'assistant');
  assert.ok(toolIndex >= 0, 'the assistant tool-call message must be in history');
  assert.equal(history[toolIndex + 1]?.role, 'tool', 'the tool result must immediately follow its call');
  const callBlocks = history[toolIndex]!.content.filter((block: any) => block.type === 'tool-call');
  assert.equal(callBlocks.length, 1);
  assert.equal(history[toolIndex + 1]!.toolCallId, callBlocks[0].id);
  assert.match(history[toolIndex + 1]!.content[0].text, /5\.10\.252-gki-xaga/);
});

await check('the next real turn can append its system prompt (protected head)', async () => {
  // The original crash was followed by exactly this: the loop's first real
  // system/message had no protected head to attach to, because the plugin's
  // synthetic records had already opened a surface without one.
  const { session } = freshSession();
  openTurn(session, 1, '!uname -r');
  await runHook(session, 1, 1, '!uname -r');
  session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } });

  modelTurn(session, 2, 'the real system prompt', 'what kernel is this?', 'Linux 5.10.');

  const { history } = reopen(session);
  assert.ok(
    history.some((message: any) => message.role === 'system' && message.content[0]?.text === 'the real system prompt'),
    'the real system prompt must survive the reopen',
  );
  assert.equal(history.filter((message: any) => message.role === 'tool').length, 1);
});

await check('another ! turn afterwards adds no second system head', async () => {
  const { session } = freshSession();
  openTurn(session, 1, '!uname -r');
  await runHook(session, 1, 1, '!uname -r');
  session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } });
  modelTurn(session, 2, 'the real system prompt', 'hello', 'hi');

  const before = session.snapshotEvents().filter((event: any) => event.type === 'system/message').length;
  openTurn(session, 3, '!ls');
  const decision = await runHook(session, 3, 1, '!ls', 'a.txt\n');
  assert.equal(decision.kind, 'reject');
  session.append('turn/end', { turn: 3, reason: { kind: 'blocked' } });

  const after = session.snapshotEvents().filter((event: any) => event.type === 'system/message').length;
  assert.equal(after, before, 'an existing surface already has its head');

  const { history } = reopen(session);
  assert.equal(history.filter((message: any) => message.role === 'tool').length, 2);
  assert.equal(history.filter((message: any) => message.role === 'system').length, 1);
});

await check('a failing command reopens as a normal tool error', async () => {
  const { session } = freshSession();
  openTurn(session, 1, '!false');
  await runHook(session, 1, 1, '!false', '', 1);
  session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } });

  const { history } = reopen(session);
  const result = history.find((message: any) => message.role === 'tool');
  assert.equal(result?.isError, true);
  assert.match(result!.content[0].text, /\[exit 1\]/);
});

await check('the tool result cites its call event from the same turn and step', async () => {
  const { session } = freshSession();
  openTurn(session, 1, '!ls');
  await runHook(session, 1, 1, '!ls', 'a.txt\n');
  session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } });

  const events: any[] = session.snapshotEvents();
  const call = events.find((event) => event.type === 'tool/call');
  const result = events.find((event) => event.type === 'tool/result');
  const assistant = events.find((event) => event.type === 'assistant/message');
  assert.ok(call !== undefined && result !== undefined && assistant !== undefined);
  assert.deepEqual(result.sourceEventSeqs, [call.seq]);
  assert.equal(result.data.turn, call.data.turn);
  assert.equal(result.data.step, call.data.step);
  assert.equal(result.data.message.source.callId, call.data.callId);
  assert.equal(assistant.data.message.content[0].id, call.data.callId);
});

console.log(failures === 0 ? `\nAll ${checks} checks passed.\n` : `\n${failures} of ${checks} check(s) failed.\n`);
process.exitCode = failures === 0 ? 0 : 1;
