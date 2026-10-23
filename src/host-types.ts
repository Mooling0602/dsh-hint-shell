/**
 * Agent / session / message shapes used by the host half.
 *
 * These are deliberately structural and minimal rather than imported from the
 * Harness type packages: a plugin bundle ships as plain JavaScript, so the types
 * only need to describe the fields this file actually reads. Keeping them local
 * also means an upstream field rename shows up as a compile error here instead
 * of being silently threaded through an `any`.
 */

/** A text content block. */
export interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

/** A tool-call content block requested by an assistant message. */
export interface ToolCallBlock {
  readonly type: 'tool-call';
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** Any content block this file inspects. */
export type ContentBlock = TextBlock | ToolCallBlock | { readonly type: string };

/** A message as it appears in the pre-step payload. */
export interface Message {
  readonly role: string;
  readonly content?: readonly ContentBlock[];
  readonly toolCallId?: string;
  /** Present on payload messages; the loop tags each source kind. */
  readonly source?: { readonly kind?: string };
}

/** The surface metadata accepted by `Session.append`. */
export interface SurfaceIntent {
  readonly surfaceOp: 'append';
  /**
   * Earlier events this surface event derives from. A tool result cites the
   * `tool/call` it answers; an assistant message embeds its own stream and must
   * not cite anything.
   */
  readonly sourceEventSeqs?: readonly number[];
}

/** Live view of the model-visible surface, read to avoid stealing its head. */
export interface SessionSurfaceLike {
  /** Event seqs currently on the surface, in model-visible order. */
  readonly nodes: readonly number[];
}

/** A durable session log. */
export interface SessionLike {
  append(type: string, data: unknown, intent?: SurfaceIntent): { readonly seq: number };
  /**
   * Optional surface view. An empty surface tells the plugin it has to reserve
   * the protected system head before appending records of its own.
   */
  readonly surface?: SessionSurfaceLike;
}

/** The receiving agent, as seen by a scoped event listener. */
export interface AgentLike {
  readonly id: string;
  readonly session: SessionLike;
}

/** The `agent/pre-step` payload. */
export interface PreStepPayload {
  readonly agent: AgentLike;
  readonly messages: readonly Message[];
  readonly turn?: number;
  readonly step: number;
  readonly signal: AbortSignal;
}

/** The decision returned to the loop. */
export type PreStepDecision = { readonly kind: 'reject' } | { readonly kind: 'enter'; readonly messages: readonly Message[] };

/** The plugin context surface this file uses. */
export interface HostPluginContext {
  on(
    name: 'agent/pre-step',
    listener: (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>,
  ): void;
  /**
   * Read a composed service without declaring a hard dependency.
   *
   * `inject` would gate the plugin on the service existing, and the hints have to
   * keep working without a provider, so every service is read optionally here.
   * Reading a service as a bare property (`ctx.workingDirectory`) throws in
   * cordis unless it was injected — which is exactly the trap `get` avoids.
   */
  get(name: 'subprocess'): import('./exec.ts').SubprocessLike | undefined;
  get(name: 'workingDirectory'): { get(session: SessionLike): string } | undefined;
  readonly logger?: { warn(message: string): void };
}
