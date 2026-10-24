/**
 * The limits every `!` command is bound by.
 *
 * Only one of them is this plugin's own. A `!` line is transcribed into an
 * ordinary tool call, so the deadline and the output cap are the ones the
 * official shell executor already applies to any command it runs: they are read
 * from that executor's own settings entry (`bash-sandbox`, or `pwsh-sandbox` on
 * Windows) instead of being decided again here. A second surface for a number
 * that already has one is how the two drift apart, and a user who tightened the
 * terminal timeout expects every `!` command to obey it.
 *
 * `maxCommandChars` has no official counterpart because an ordinary tool call
 * has no such limit to inherit: the model writes the command into
 * `tool-call.arguments`, so an unbounded line would enter the next request
 * twice over — once as the argument and once as the result's echo.
 */

import type { Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

/** Per-stream in-memory cap in bytes; overflow spills to a temporary file. */
export const MAX_OUTPUT_BYTES = 64_000;

/** Longest single command line accepted, in characters. */
export const DEFAULT_MAX_COMMAND_CHARS = 10_000;

/**
 * Whole-stream spill cap in bytes.
 *
 * A command that produces more than this loses its spill file rather than
 * filling the disk; the in-memory tail still reports what it kept. Deliberately
 * not user-facing: it bounds damage, it does not shape behavior worth tuning.
 */
const MAX_SPILL_BYTES = 12_000_000;

/** Grace before a timed-out command's process group is force-killed. */
export const GRACE_MS = 2_000;

/**
 * Fallback deadline, in milliseconds.
 *
 * Used only when the official shell executor's entry cannot be read — an older
 * composition, a profile that names the entry differently, or a Host without
 * the settings service. It matches `bash-local`'s own default, so a missing read
 * behaves like a stock installation rather than a different one.
 */
export const FALLBACK_TIMEOUT_MS = 120_000;

/** Live configuration handed to `apply`. */
export interface Config {
  /** Longest single command line accepted, in characters. */
  maxCommandChars: Volatile<number>;
}

/**
 * Schema the Host projects into the settings page.
 *
 * One field, because one is all this plugin decides for itself. `.min(1)` is
 * what makes the form reject a zero before it reaches a command: a zero cap
 * would refuse every line, including the examples the hint invites.
 */
export const Config = z.object({
  maxCommandChars: z.number().step(1).min(1).default(DEFAULT_MAX_COMMAND_CHARS).volatile(),
});

/** The resolved limits one command runs under. */
export interface Limits {
  /** Deadline for the whole command. */
  readonly timeoutMs: number;
  /** Per-stream in-memory cap. */
  readonly maxOutputBytes: number;
  /** Whole-stream spill cap. */
  readonly maxSpillBytes: number;
  /** Longest accepted command line. */
  readonly maxCommandChars: number;
  /** Grace before force-killing a terminated command's process group. */
  readonly graceMs: number;
}

/** The shell executor's values, as this plugin inherits them. */
export interface ShellBudget {
  /** Foreground command timeout in milliseconds. */
  readonly timeoutMs?: number;
  /** Per-stream in-memory output cap in bytes. */
  readonly maxOutputBytes?: number;
}

/**
 * Read the live limits once, so one command sees one consistent snapshot.
 *
 * @param config - the live plugin configuration.
 * @param budget - the official shell executor's values, when they could be read.
 * @returns the limits this command runs under.
 */
export function readLimits(config: Config | undefined, budget: ShellBudget = {}): Limits {
  return {
    timeoutMs: positiveOr(budget.timeoutMs, FALLBACK_TIMEOUT_MS),
    maxOutputBytes: positiveOr(budget.maxOutputBytes, MAX_OUTPUT_BYTES),
    maxSpillBytes: MAX_SPILL_BYTES,
    // A plugin mounted before this field existed (or a hand-edited profile
    // patch) can hand `undefined` here; the default keeps commands runnable.
    maxCommandChars: positiveOr(config?.maxCommandChars?.get(), DEFAULT_MAX_COMMAND_CHARS),
    graceMs: GRACE_MS,
  };
}

/**
 * Coerce a live value to a usable positive finite number.
 *
 * @param value - the value read from configuration, possibly `undefined`.
 * @param fallback - the default to use when the value is unusable.
 * @returns the value when it is a positive finite number, else the fallback.
 */
function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** One `settings.describe()` descriptor, narrowed to what the budget read needs. */
interface DescriptorLike {
  readonly ns: string;
  readonly value?: unknown;
}

/**
 * Pick the shell executor's budget out of one `settings.describe()` result.
 *
 * The POSIX executor wins when both are served: only one of them runs commands
 * on a given platform, and preferring a fixed order keeps the choice stable
 * across a reload. Each field is validated on its own, so one unusable value
 * does not discard a usable neighbour; {@link readLimits} then falls back per
 * field rather than all-or-nothing.
 *
 * @param entries - the descriptors `settings.describe()` returned.
 * @returns the inherited values, possibly empty.
 */
export function shellBudgetFrom(entries: readonly DescriptorLike[]): ShellBudget {
  const entry = entries.find(candidate => candidate.ns === BASH_NS)
    ?? entries.find(candidate => candidate.ns === PWSH_NS);
  if (entry === undefined) return {};
  const value = entry.value;
  if (typeof value !== 'object' || value === null) return {};
  const record = value as Record<string, unknown>;
  return {
    timeoutMs: usable(record.timeoutMs),
    maxOutputBytes: usable(record.maxOutputBytes),
  };
}

/**
 * Read one numeric field, dropping it when it cannot bound a command.
 *
 * @param value - the field as stored.
 * @returns the number, or `undefined` to let the caller fall back.
 */
function usable(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** Settings namespace of the POSIX shell executor; its page owns these two numbers. */
const BASH_NS = 'bash-sandbox';

/** Settings namespace of the PowerShell executor, composed instead on Windows. */
const PWSH_NS = 'pwsh-sandbox';
