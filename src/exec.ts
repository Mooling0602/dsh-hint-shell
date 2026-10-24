/**
 * `!` command execution — the host half's only real work.
 *
 * Semantics this file owns:
 *
 * - A draft whose first non-space character is `!` is a shell line. Everything
 *   after that `!` is the command, so both `!ls` and `! ls` mean `ls`.
 * - The command runs as a real subprocess in the session's working directory.
 * - The call and its result are appended to the session log as an ordinary
 *   `tool/call` + `tool/result` pair, which is what puts them on the model-visible
 *   surface. Appending directly is the point: it records the outcome for the
 *   *next* request without starting one.
 * - Nothing here talks to a model. The turn that carried the `!` line is stopped
 *   by the pre-step hook before dispatch, so a `!` line costs zero tokens.
 */

import { readLimits, type Config, type Limits, type ShellBudget } from './config.ts';

/** A parsed shell line. */
export interface ShellLine {
  /** The command text, with the leading `!` and surrounding whitespace removed. */
  command: string;
}

/**
 * Parse a draft as a `!` shell line.
 *
 * Mirrors how this Harness treats its own trigger symbols: `/` is only a command
 * once at least one name character follows it (`parseCommand` returns
 * `undefined` for a bare slash, and the composer's `matchEnter` bails on an
 * empty token), so a lone symbol stays ordinary text. `!` follows the same rule —
 * a bare `!` is prose, and only `!` with a command behind it is shell intent.
 *
 * @param text - the submitted message text.
 * @returns the parsed line, or `undefined` when this is not shell intent.
 */
export function parseShellLine(text: string): ShellLine | undefined {
  // Leading whitespace is tolerated because the composer trims on submit but a
  // pasted line may carry it; the symbol must still be the first real character.
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('!')) return undefined;
  const command = trimmed.slice(1).trim();
  // No command means no shell line: send the `!` to the model as the text it is.
  if (command === '') return undefined;
  return { command };
}

/** One finished command. */
export interface ShellOutcome {
  /** Command text that actually ran, or `undefined` when nothing was executed. */
  command?: string;
  stdout: string;
  stderr: string;
  /** Exit code, or `null` when the process was killed by a signal. */
  exitCode: number | null;
  /** Signal that ended the process, when one did. */
  signal: string | null;
  /** Set when the line could not be executed at all (no command, spawn failure). */
  failure?: string;
  /** Set when the command was terminated because it outlived its deadline. */
  timedOut?: boolean;
  /** Set when the command was rejected before it ran because the line was too long. */
  rejectedTooLong?: boolean;
  truncated: boolean;
  /** Files holding the complete output streams, when truncation spilled them. */
  spill: { stdout?: string; stderr?: string };
}

/** Minimal shape of the subprocess service this file needs. */
export interface SubprocessLike {
  spawn(spec: {
    argv: readonly string[];
    cwd: string;
    stdio: {
      stdin: 'ignore';
      stdout: { maxBytes: number; spill?: { maxBytes: number } };
      stderr: { maxBytes: number; spill?: { maxBytes: number } };
    };
    graceMs: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
  }): {
    collected: {
      stdout?: {
        readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string };
      };
      stderr?: {
        readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string };
      };
    };
    done: Promise<{ exitCode: number | null; signal: string | null }>;
    terminate(): void;
  };
}

/**
 * Run one shell line and collect its output.
 *
 * The caller owns the deadline: `subprocess` only reacts to the abort signal
 * it is handed, so the timeout lives here as a timer that aborts the same
 * signal the request uses. A timed-out command is a normal result — the turn
 * still records what it managed to print — so the reason is reported through
 * {@link ShellOutcome.timedOut} rather than thrown.
 *
 * @param subprocess - the composed subprocess service.
 * @param line - the parsed line.
 * @param cwd - the session's working directory.
 * @param signal - cancellation owned by the submitting request.
 * @param config - live limits; read once so one command sees one snapshot.
 * @param budget - the shell executor's own timeout and output cap.
 * @returns the settled outcome; a spawn failure is reported through `failure`
 *   rather than thrown, because a failed command is a normal command result.
 */
export async function runShellLine(
  subprocess: SubprocessLike,
  line: ShellLine,
  cwd: string,
  signal: AbortSignal,
  config?: Config,
  budget?: ShellBudget,
): Promise<ShellOutcome> {
  const limits: Limits = readLimits(config, budget);
  const empty: ShellOutcome = {
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
    truncated: false,
    spill: {},
  };

  if (line.command === '') {
    return { ...empty, failure: 'no command given' };
  }

  // Reject before spawning: an over-long line is a user mistake worth naming,
  // and it must not reach the log twice over (arguments plus result echo).
  if (line.command.length > limits.maxCommandChars) {
    return {
      ...empty,
      command: line.command,
      rejectedTooLong: true,
      failure: `the command is ${line.command.length} characters long, over the ${limits.maxCommandChars}-character limit`,
    };
  }

  // One controller combines the request's cancellation with this command's
  // own deadline, so the provider sees a single abort signal either way.
  // `raceSignal` is unavailable on older runtimes, so forward by hand.
  const deadline = new AbortController();
  const abort = (): void => { deadline.abort(); };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    deadline.abort();
  }, limits.timeoutMs);

  let handle;
  try {
    handle = subprocess.spawn({
      // The shell owns the parsing, so quoting, pipes, and globs behave exactly
      // as they would in a terminal rather than being re-implemented here.
      argv: [shellPath(), '-c', line.command],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: limits.maxOutputBytes, spill: { maxBytes: limits.maxSpillBytes } },
        stderr: { maxBytes: limits.maxOutputBytes, spill: { maxBytes: limits.maxSpillBytes } },
      },
      graceMs: limits.graceMs,
      signal: deadline.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    return {
      ...empty,
      command: line.command,
      failure: error instanceof Error ? error.message : String(error),
    };
  }

  // `done` rejects for spawn or provider failures, which are command results
  // rather than reasons to lose the whole record.
  let outcome: { exitCode: number | null; signal: string | null };
  try {
    outcome = await handle.done;
  } catch (error) {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    return {
      ...empty,
      command: line.command,
      failure: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // The deadline must not outlive the process: a fired timer on a finished
    // command would abort a controller nobody reads, but leaving it armed for
    // a long-lived turn is still a leak.
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }

  // Collect-mode readers are offset based and non-consuming, so reading once
  // from 0 returns everything that was buffered.
  const stdout = handle.collected.stdout?.readFrom(0);
  const stderr = handle.collected.stderr?.readFrom(0);

  return {
    command: line.command,
    stdout: stdout?.text ?? '',
    stderr: stderr?.text ?? '',
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut,
    truncated: (stdout?.lossy ?? false) || (stderr?.lossy ?? false),
    spill: {
      ...(stdout?.spillPath === undefined ? {} : { stdout: stdout.spillPath }),
      ...(stderr?.spillPath === undefined ? {} : { stderr: stderr.spillPath }),
    },
  };
}

/** Shell used to interpret a command line. */
function shellPath(): string {
  return process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
}

/**
 * Render an outcome as the text a model reads inside the tool result.
 *
 * The command itself is echoed so the result stays self-describing once it is
 * far from the `!` line that produced it. The echo is elided for an over-long
 * line: that outcome never ran anything, and repeating ten thousand characters
 * to say "too long" would cost the very context the limit protects.
 *
 * @param outcome - the settled outcome.
 * @returns the model-facing text.
 */
export function formatOutcome(outcome: ShellOutcome): string {
  const echo = outcome.rejectedTooLong === true
    ? `$ ${elide(outcome.command ?? '')}`
    : `$ ${outcome.command ?? ''}`;
  if (outcome.failure !== undefined) return `${echo}\n${outcome.failure}`;

  const parts: string[] = [echo];
  if (outcome.stdout !== '') parts.push(outcome.stdout.replace(/\n$/, ''));
  if (outcome.stderr !== '') parts.push(`[stderr]\n${outcome.stderr.replace(/\n$/, '')}`);
  if (outcome.truncated) {
    // A settled cap is only safe to mention when the full stream survived
    // somewhere; otherwise the model would be told a gap it cannot recover.
    const spilled = [outcome.spill.stdout, outcome.spill.stderr].filter((path): path is string => path !== undefined);
    parts.push(spilled.length === 0
      ? '[output truncated; the full stream was too large to keep]'
      : `[output truncated; full stream: ${spilled.join(', ')}]`);
  }

  // A timeout is classified from the caller's own deadline, not from the
  // provider's outcome: the process group may report SIGTERM either way.
  const status = outcome.timedOut === true
    ? 'timed out and was terminated'
    : outcome.signal !== null
      ? `killed by ${outcome.signal}`
      : `exit ${outcome.exitCode ?? 'unknown'}`;
  parts.push(`[${status}]`);
  return parts.join('\n');
}

/**
 * Shorten a command for display without splitting a surrogate pair.
 *
 * @param command - the command text.
 * @returns the command itself when short, else a head slice with an ellipsis.
 */
function elide(command: string): string {
  const head = [...command].slice(0, 200).join('');
  return command.length > 200 ? `${head}… (${command.length} characters)` : command;
}

/** Whether an outcome should be reported to the model as a tool error. */
export function isFailed(outcome: ShellOutcome): boolean {
  return outcome.failure !== undefined
    || outcome.timedOut === true
    || outcome.signal !== null
    || (outcome.exitCode ?? 0) !== 0;
}
