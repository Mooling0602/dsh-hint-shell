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

/** Same cap the shipped shell tools apply, so a runaway command cannot flood a context. */
const MAX_OUTPUT_BYTES = 30_000;

/** Grace before a command's process group is force-killed. */
const GRACE_MS = 2_000;

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
  truncated: boolean;
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
      stdout?: { readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean } };
      stderr?: { readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean } };
    };
    done: Promise<{ exitCode: number | null; signal: string | null }>;
    terminate(): void;
  };
}

/**
 * Run one shell line and collect its output.
 *
 * @param subprocess - the composed subprocess service.
 * @param line - the parsed line.
 * @param cwd - the session's working directory.
 * @param signal - cancellation owned by the submitting request.
 * @returns the settled outcome; a spawn failure is reported through `failure`
 *   rather than thrown, because a failed command is a normal command result.
 */
export async function runShellLine(
  subprocess: SubprocessLike,
  line: ShellLine,
  cwd: string,
  signal: AbortSignal,
): Promise<ShellOutcome> {
  const empty: ShellOutcome = {
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
    truncated: false,
  };

  if (line.command === '') {
    return { ...empty, failure: 'no command given' };
  }

  let handle;
  try {
    handle = subprocess.spawn({
      // The shell owns the parsing, so quoting, pipes, and globs behave exactly
      // as they would in a terminal rather than being re-implemented here.
      argv: [shellPath(), '-c', line.command],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: MAX_OUTPUT_BYTES },
        stderr: { maxBytes: MAX_OUTPUT_BYTES },
      },
      graceMs: GRACE_MS,
      signal,
    });
  } catch (error) {
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
    return {
      ...empty,
      command: line.command,
      failure: error instanceof Error ? error.message : String(error),
    };
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
    truncated: (stdout?.lossy ?? false) || (stderr?.lossy ?? false),
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
 * far from the `!` line that produced it.
 *
 * @param outcome - the settled outcome.
 * @returns the model-facing text.
 */
export function formatOutcome(outcome: ShellOutcome): string {
  if (outcome.failure !== undefined) return `$ ${outcome.command ?? ''}\n${outcome.failure}`;

  const parts: string[] = [`$ ${outcome.command ?? ''}`];
  if (outcome.stdout !== '') parts.push(outcome.stdout.replace(/\n$/, ''));
  if (outcome.stderr !== '') parts.push(`[stderr]\n${outcome.stderr.replace(/\n$/, '')}`);
  if (outcome.truncated) parts.push('[output truncated]');

  const status = outcome.signal !== null
    ? `killed by ${outcome.signal}`
    : `exit ${outcome.exitCode ?? 'unknown'}`;
  parts.push(`[${status}]`);
  return parts.join('\n');
}

/** Whether an outcome should be reported to the model as a tool error. */
export function isFailed(outcome: ShellOutcome): boolean {
  return outcome.failure !== undefined || outcome.signal !== null || (outcome.exitCode ?? 0) !== 0;
}
