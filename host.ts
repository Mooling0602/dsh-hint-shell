/**
 * Host half of `dsh-hint-shell`.
 *
 * The composer copy is produced by the browser half. This file owns the other
 * half of the feature: running a `!` line and recording it in the session.
 *
 * ── Why this is a pre-step hook ────────────────────────────────────────────
 *
 * A `!` line must behave like a tool call *without* paying for a model request.
 * `agent/pre-step` is the last point where the loop holds the messages that are
 * about to be sent and has not dispatched yet, and its `reject` decision stops
 * the request. So the hook sees the line, runs it, records the outcome, and
 * rejects — the turn ends with the conversation advanced and no tokens spent.
 *
 * ── Why the records have this shape ────────────────────────────────────────
 *
 * The session log is format v4, and v4 is validated when a session is reopened:
 * every surface message needs a first-class string id, a tool result needs a
 * first-class tool-role message whose `source.callId` matches its `toolCallId`,
 * every surface message needs an open step, and the first surface node must be
 * the protected `system/message` head. A naive three-event pair violates all
 * four and makes the session unreadable the next time it is opened. The records
 * are therefore written the way the agent loop writes its own:
 *
 * 1. `step/start` — pre-step runs before the loop opens its step, so the plugin
 *    opens one for the pair and closes it with `step/end` afterwards.
 * 2. `system/message` (empty, only when the surface is still empty) — reserves
 *    the protected head the loop's real system prompt needs later. Empty
 *    content derives to no model message, so this is invisible to the model and
 *    to the transcript.
 * 3. `assistant/message` carrying the `tool-call` block (identified message).
 * 4. `tool/call` (log-only, for the UI and replay).
 * 5. `tool/result` (identified tool-role message linked by the same call id),
 *    citing the `tool/call` seq as its source event.
 * 6. `step/end` — closes the synthetic step so `turn/end` stays legal.
 *
 * Because these are appends to the durable log and the step was rejected, the
 * command's output sits in the history for the *next* request without one being
 * made for it.
 */

import { randomUUID } from 'node:crypto';

import {
  formatOutcome,
  isFailed,
  parseShellLine,
  runShellLine,
  type ShellLine,
  type ShellOutcome,
  type SubprocessLike,
} from './src/exec.ts';
import { shellBudgetFrom, type Config, type ShellBudget } from './src/config.ts';
import type {
  AgentLike,
  HostPluginContext,
  Message,
  PreStepDecision,
  SessionLike,
} from './src/host-types.ts';

/** Plugin name, matching the profile bundle row. */
export const name = 'dsh-hint-shell';

/**
 * No hard service dependency.
 *
 * Declaring `subprocess` here would make Cordis refuse to mount the whole plugin
 * when none is composed, which would also take down the composer hints in the
 * browser half. The service is instead read optionally through `ctx.get`, so the
 * hints always work and only execution degrades: a `!` line then records a tool
 * error explaining that no provider is available.
 */
export const inject = [];

/** Tool name the recorded call uses, so the pair reads like a normal tool call. */
export const TOOL_NAME = 'shell';

/** Re-exported so the profile's configuration schema travels with the plugin. */
export { Config, DEFAULT_MAX_COMMAND_CHARS, FALLBACK_TIMEOUT_MS, GRACE_MS, MAX_OUTPUT_BYTES } from './src/config.ts';

/** Cap on how much of one command's output enters the log. */
const MAX_LOGGED_CHARS = 30_000;

/** Per-session turn counters, so an appended turn number stays monotonic. */
const lastTurn = new WeakMap<SessionLike, number>();

/** Turn/step the synthetic records belong to. */
interface Position {
  readonly turn: number;
  readonly step: number;
}

/**
 * Install the `!` handler for every live agent.
 *
 * @param ctx - the plugin context; `subprocess` is available through `inject`.
 * @param config - live configuration; limits are read per command.
 */
export function apply(ctx: HostPluginContext, config?: Config): void {
  ctx.on('agent/pre-step', async (payload, next) => {
    const line = lastShellLine(payload.messages);
    // Ordinary prose: leave the step completely untouched.
    if (line === undefined) return next();

    const session = payload.agent.session;
    const position: Position = { turn: nextTurn(session, payload.turn), step: payload.step };
    const outcome = await runLine(ctx, session, line, payload.signal, config);
    const command = outcome.command ?? line.command;
    // Recording a `!` line must never leave the turn looking successful while
    // nothing was written: a session append that refuses rejects this turn with
    // the real error instead of being swallowed.
    emitOutcome(session, position, command, outcome);
    return { kind: 'reject' };
  });
}

/**
 * Find the `!` line among the messages about to enter the step.
 *
 * Only the newest user message decides. An older `!` line in a long history was
 * already handled on its own turn and must not run again.
 *
 * @param messages - candidate messages.
 * @returns the parsed line, or `undefined` when this is not shell intent.
 */
function lastShellLine(messages: readonly Message[]): ShellLine | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    // The loop also delivers injected context (`time-context`, `runtime-context`)
    // as the `user` role. Only a message a human actually typed may become a
    // command, or injected text starting with `!` would be executed.
    if (message.source?.kind !== 'user') continue;
    return parseShellLine(textOf(message));
  }
  return undefined;
}

/**
 * Concatenate a message's text blocks.
 *
 * @param message - any message carrying content blocks.
 * @returns the joined text.
 */
function textOf(message: Message): string {
  const blocks = message.content ?? [];
  return blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/**
 * Run the line and settle on an outcome that is always safe to record.
 *
 * Every failure — an unresolvable working directory, a missing provider, a
 * spawn throw — becomes a failed {@link ShellOutcome} so that it can be written
 * as a normal tool error instead of losing the record. Only the appends below
 * can still fail, and a refused append throws so the turn fails loudly.
 *
 * @param ctx - plugin context.
 * @param session - the session whose working directory the command uses.
 * @param line - the parsed shell line.
 * @param signal - cancellation owned by the submitting request.
 * @param config - live configuration, read once for a consistent snapshot.
 * @returns the settled outcome.
 */
async function runLine(
  ctx: HostPluginContext,
  session: SessionLike,
  line: ShellLine,
  signal: AbortSignal,
  config?: Config,
): Promise<ShellOutcome> {
  let cwd: string;
  let subprocess: SubprocessLike | undefined;
  let budget: ShellBudget = {};
  try {
    // Read the services rather than inject them: `inject` would gate the plugin
    // on a working-directory provider, and reading a service as a bare property
    // throws in cordis for that same reason. The session carries no
    // `workingDirectory` field either — the directory lives in a session
    // projection behind the service — so `ctx.get(...)` is the supported way in.
    cwd = ctx.get('workingDirectory')?.get(session) ?? process.cwd();
    subprocess = ctx.get('subprocess');
    // The deadline and the output cap are the shell executor's, not this
    // plugin's: a `!` line is a tool call, so it obeys the same budget the
    // official bash tool does. A Host without the settings service leaves this
    // empty and `readLimits` falls back to the executor's own defaults.
    budget = shellBudgetFrom(ctx.get('settings')?.describe() ?? []);
  } catch (error) {
    return failedOutcome(line, `the session environment could not be resolved: ${detailOf(error)}`);
  }

  if (subprocess === undefined) return noSubprocess(line);
  try {
    return await runShellLine(subprocess, line, cwd, signal, config, budget);
  } catch (error) {
    // runShellLine already reports spawn and exit failures; this only catches a
    // provider that throws outside that seam. A failed command is still a result.
    return failedOutcome(line, detailOf(error));
  }
}

/**
 * Render one outcome into the paired records.
 *
 * @param session - the session to append to.
 * @param position - the turn and step the records belong to.
 * @param command - the command that produced the result.
 * @param outcome - the settled outcome.
 */
function emitOutcome(session: SessionLike, position: Position, command: string, outcome: ShellOutcome): void {
  // Prefix after `clamp`: the attribution must survive truncation, and it must
  // not consume the output budget a command's own result is entitled to.
  emitPair(session, position, command, `${PROVENANCE}\n${clamp(formatOutcome(outcome))}`, isFailed(outcome));
}

/**
 * Provenance line prefixed to every result this plugin writes.
 *
 * A `!` line becomes an ordinary tool call, and the wire format carries only the
 * call's `type`/`id`/`name`/`input` — never the message `source`. So the model
 * cannot otherwise tell this call apart from one it issued itself, and the
 * record would read as its own action on the next request. This line is the only
 * place in that record the model actually sees, which is why the attribution
 * lives here rather than in the message `source`.
 *
 * It is prefixed after {@link clamp}, so it never spends the output budget and
 * a truncated result still opens with it.
 */
const PROVENANCE = '[run by the user via `!` prompt symbol]';

/**
 * Append the six records that make one `!` line a valid v4 tool exchange.
 *
 * The surface events are written in the order the agent loop writes its own, so
 * replay, providers, and the UI see exactly the shape they already understand.
 * The synthetic step is opened and closed here because `agent/pre-step` runs
 * before the loop's own `step/start`, and v4 requires an open step for every
 * surface message.
 *
 * @param session - the session to append to.
 * @param position - the turn and step the records belong to.
 * @param command - the command that produced the result.
 * @param text - the formatted output.
 * @param failed - whether the result reads as a tool error.
 */
function emitPair(
  session: SessionLike,
  position: Position,
  command: string,
  text: string,
  failed: boolean,
): void {
  const { turn, step } = position;
  // A counter would restart with the process and could hand a reopened session
  // an id it already logged; a UUID is unique across restarts and forks.
  const callId = `dsh-hint-shell-${randomUUID()}`;
  const argumentsText = JSON.stringify({ command });

  session.append('step/start', { turn, step });
  try {
    // V4 protects the first system message on the surface: a later
    // `system/message` may only be appended once one exists. A `!` line can be
    // the first thing a session ever does, so reserve an empty head — content
    // that derives to no model message and renders no transcript row. Without
    // it, the loop's real prompt on the next turn would be unappendable and the
    // session would become unreadable.
    if ((session.surface?.nodes.length ?? 0) === 0) {
      session.append(
        'system/message',
        {
          turn,
          step,
          message: {
            id: randomUUID(),
            role: 'system',
            content: [],
            source: { kind: 'system-prompt' },
          },
        },
        { surfaceOp: 'append' },
      );
    }

    // 1. The assistant message that "requested" the call. Providers require this
    //    block to accept the result that follows. `stream` is empty because no
    //    model stream produced this record — it is synthesized locally.
    session.append(
      'assistant/message',
      {
        turn,
        step,
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [{ type: 'tool-call', id: callId, name: TOOL_NAME, arguments: argumentsText }],
          source: { kind: 'model', provider: 'dsh-hint-shell', model: 'shell' },
        },
        stream: [],
      },
      { surfaceOp: 'append' },
    );

    // 2. The log-only call record, exactly as the loop writes its own.
    const call = session.append('tool/call', {
      turn,
      step,
      callId,
      name: TOOL_NAME,
      arguments: argumentsText,
    });

    // 3. The model-facing result, linked by the same call id. Both the
    //    `toolCallId` and the message's tool source carry it: v4 reconciles the
    //    two, and the UI pairs the result with its call through the source.
    session.append(
      'tool/result',
      {
        turn,
        step,
        message: {
          id: randomUUID(),
          role: 'tool',
          toolCallId: callId,
          content: [{ type: 'text', text }],
          source: { kind: 'tool', callId },
          isError: failed,
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [call.seq] },
    );
  } finally {
    // Close the synthetic step even when an append above refuses: a surface step
    // with no `step/end` would make the next `turn/end` illegal.
    session.append('step/end', { turn, step });
  }
}

/**
 * Outcome used when no subprocess provider is composed.
 *
 * @param line - the parsed line.
 * @returns a failed outcome describing the missing service.
 */
function noSubprocess(line: ShellLine): ShellOutcome {
  return {
    command: line.command,
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
    truncated: false,
    spill: {},
    failure: 'shell execution is unavailable: no `subprocess` provider is composed',
  };
}

/**
 * Outcome for a line that could not be executed or recorded at all.
 *
 * @param line - the parsed line.
 * @param failure - the reason, shown to the model and the user.
 * @returns a failed outcome.
 */
function failedOutcome(line: ShellLine, failure: string): ShellOutcome {
  return {
    command: line.command,
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
    truncated: false,
    spill: {},
    failure,
  };
}

/**
 * Render any thrown value as one diagnostic line.
 *
 * @param error - the thrown value.
 * @returns its message, or the string coercion.
 */
function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keep the turn number monotonic across appended records.
 *
 * The rejected turn still consumes its number, so a later real request does not
 * reuse it and the log reads in order.
 *
 * @param session - the session being written.
 * @param reported - the turn number from the payload.
 * @returns a turn number at least one greater than the previous one used.
 */
function nextTurn(session: SessionLike, reported: number | undefined): number {
  const previous = lastTurn.get(session) ?? 0;
  const turn = Math.max(reported ?? 0, previous + 1);
  lastTurn.set(session, turn);
  return turn;
}

/**
 * Clamp long output so one command cannot dominate a context.
 *
 * The status line is reserved, not appended after the cut: `[exit N]` (or a
 * timeout/kill reason) is the part a reader needs to judge the result, and a
 * plain head slice over a large output used to drop it along with everything
 * else. Cutting is also code-point aware, so an emoji or CJK extension
 * character at the boundary is never split into a lone surrogate.
 *
 * @param text - the formatted output.
 * @returns the text, truncated at {@link MAX_LOGGED_CHARS}.
 */
function clamp(text: string): string {
  if (text.length <= MAX_LOGGED_CHARS) return text;
  const marker = `\n[output truncated at ${MAX_LOGGED_CHARS} characters]`;
  // The formatted text always ends with its status line; keep it verbatim.
  const statusAt = text.lastIndexOf('\n[');
  const status = statusAt === -1 ? '' : text.slice(statusAt);
  const room = MAX_LOGGED_CHARS - marker.length - status.length;
  // A pathological status line could exceed the budget on its own; then the
  // status wins and the body is dropped entirely rather than cut into it.
  if (room <= 0) return `${status.slice(1)}${marker}`;
  const head = [...text.slice(0, room)].join('');
  return `${head}${marker}${status}`;
}

/** Re-exported for tests. */
export type { PreStepDecision, AgentLike };
