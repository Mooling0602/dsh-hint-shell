# dsh-hint-shell

A DeepSeek Harness plugin that makes `!` a shell prefix in the composer.

- **Empty composer** — appends `，输入 ! 执行 shell 命令` to the shipped placeholder, so it reads
  `发消息或创建任务, / 调用指令, @ 文件或对话，输入 ! 执行 shell 命令`.
- **After typing `!`** — shows a gray hint `输入 shell 命令…` right after the `!`.
- **On submit** — a line like `!ls` runs as a real shell command in the session's working
  directory. Its output is recorded in the session as a tool call and result, so the next real
  request already sees it. **No model request is made for the `!` line itself.**

Nothing else changes: no new button, no replaced component, no altered keyboard behaviour.

## `!` follows the same convention as `/`

The Harness treats a trigger symbol as a trigger only once something follows it: `parseCommand`
requires at least one name character after `/`, and the composer's `matchEnter` bails when the token
is empty. A lone `/` is therefore ordinary text, not a command.

`!` behaves the same way. A lone `!` is prose and is sent to the model like any other message; only
`!` with a command behind it is shell intent. Both `!ls` and `! ls` mean `ls`.

## How it works

The composer effects reuse machinery the shipped composer already has.

**Idle hint** — the empty-composer placeholder is produced by a locale lookup of
`conversation/placeholder.default`. `LocaleRuntime.prototype.translate` is a prototype method, so the
plugin wraps it and appends one clause to that key (and to `placeholder.hero`, the same composer in
its empty-session layout). Every other namespace and key passes through untouched.

**Armed hint** — the shipped stylesheet already paints this exact kind of message:

```css
.input p:last-child::after {
  content: var(--dsh-composer-hint);
  color: var(--dsw-alias-label-caption);
}
```

Upstream only populates that property for a native command claim, which a `!` prefix cannot produce.
Custom properties inherit, so setting `--dsh-composer-hint` on the composer card is enough: the
shipped rule then draws the text immediately after the typed `!`, in the shipped caption colour.
The plugin adds no DOM, does no measurement, and does no positioning.

The draft itself comes from `[data-composer-input]`, the editable surface the composer already
publishes, so this plugin has no companion plugin and no dependency on internal trigger internals.

## Copy

Copy lives in the plugin's own `dsh-hint-shell` locale namespace, so registration can never collide.
The locale service's `register` is append-only and throws on a duplicate `(namespace, locale)` pair,
which is why overriding the `conversation` namespace from a plugin is not possible.

| | zh | en |
|---|---|---|
| idle clause | `，输入 ! 执行 shell 命令` | `, type ! for shell commands` |
| armed hint | `输入 shell 命令…` | `Enter a shell command…` |

Edit `src/copy.ts` to change them.

## Execution

The host half hooks `agent/pre-step`, the last point before the loop dispatches a request, and its
`reject` decision stops that request. A `!` line therefore costs zero tokens.

Recording the outcome needs a whole tool exchange, not one event. The model-visible surface carries
`tool/result` but not `tool/call`, and a tool result with no preceding assistant `tool-call` block is
a message answering a call that was never made — which a provider rejects. The records are written
the way the agent loop writes its own, and in the shape the session's format v4 reader validates when
the session is reopened:

1. `step/start` — `agent/pre-step` runs *before* the loop opens its step, and v4 requires every
   surface message to belong to an open step. The plugin opens one for the pair.
2. `system/message` with empty content — only when the surface is still empty. V4 protects the first
   system message as the surface head, and a later `system/message` cannot be appended without one. A
   `!` line can be the first thing a session ever does, so the head is reserved; empty content
   derives to no model message and renders no transcript row.
3. `assistant/message` carrying the `tool-call` block (surface event, identified message)
4. `tool/call` (log-only, for the UI and replay)
5. `tool/result` (surface event: an identified tool-role message whose `source.callId` matches its
   `toolCallId`, citing the `tool/call` seq as its source event)
6. `step/end` — closes the synthetic step so the loop's `turn/end` stays legal

Every message carries a fresh UUID `id` and a producer-owned `source.kind`, which is what the v4
reader checks on reopen. Omitting any of this is not a cosmetic problem: the live append succeeds,
then the persistence encoder refuses the row, the buffered batch never reaches the log, and the turn
fails with a format error such as `format v4 tool/result at seq 8 requires a first-class message with
a string id`.

Because these are appends to the durable log and the step was rejected, the command's output sits in
the history for the *next* request without one being made for it.

Commands run through `/bin/sh -c`, so quoting, pipes, and globs behave as in a terminal rather than
being re-implemented. Output is capped at 30 000 characters, and a non-zero exit or a signal is
reported as a tool error.

`subprocess` is read optionally rather than declared in `inject`: a hard dependency would make Cordis
refuse to mount the whole plugin when no provider is composed, taking the composer hints down with
it. Without a provider the hints still work and a `!` line records a tool error naming the missing
service.

## Development

Sources are TypeScript; both shipped JavaScript files are generated.

```sh
npm install          # typescript + esbuild + @types/node
npm run typecheck    # tsc --noEmit
npm run build        # src/ -> client.js, host.ts -> index.js
npm test             # composer, shell-line, and installed-Harness format tests
```

`test/dsh-format.test.ts` drives the host hook against an installed Harness: it appends through a
real `Session`, then encodes, admits, and restores the log through the real format v4 reader, so a
record shape the live app accepts but cannot re-open fails the suite. It resolves the harness packages
from the host installation (`DSH_MODULES`, or the global `npm root -g`) and reports a skip when none
is installed.

`client.js` must stay a single self-contained file: the Client module loader's `require` resolves
host packages only and cannot resolve relative imports, which is why the build bundles `src/` rather
than shipping it. `index.js` is built rather than shipping `.ts` so the host never depends on the
runtime having TypeScript stripping enabled.

## Layout

| Path | Purpose |
|---|---|
| `host.ts` | Host half: the `!` pre-step hook (source). |
| `index.js` | Generated Host module. Do not edit. |
| `client.js` | Generated Client bundle. Do not edit. |
| `src/copy.ts` | The two strings, in both languages. |
| `src/index.ts` | The two composer effects: placeholder clause and hint painting. |
| `src/exec.ts` | Shell-line parsing, execution, and output formatting. |
| `src/types.ts` | Structural types for the Client services used. |
| `src/host-types.ts` | Structural types for the Host services used. |
| `test/run.test.ts` | Composer integration test (fake DOM + fake locale). |
| `test/host.test.ts` | Shell-line and pre-step hook test. |
| `test/dsh-format.test.ts` | Installed-Harness test: append through a real Session, then reopen the log through the real v4 reader. |
| `cordis.patch.yml` | Profile bundle row. |

## Behaviour notes

- The hint shows only while the draft is the bare `!`; typing a command clears it. No space is
  needed after the `!`.
- The hint never shows on an empty composer (the placeholder covers that case) or in the middle of a
  sentence (`hello !world` is ordinary text).
- The hint follows the active locale; switching language re-renders it.
- Uninstalling restores the original `translate`.

### Why a MutationObserver is involved

The editable surface belongs to Lexical, which commits typed text into its own paragraph nodes
inside its update pass. That pass is not guaranteed to finish before the browser dispatches `input`,
so a synchronous read of `[data-composer-input]` can still describe the *previous* character. Reading
only on `input` made a bare `!` appear one keystroke late — it showed up after the space that
followed, and then appeared to "stick" when the draft was deleted back to `!`.

The plugin therefore repaints on the mutation Lexical actually makes, which is the authoritative
signal that the text is in the DOM. A deferred read on `input` remains as a safety net. Both paths
only schedule a paint, so an extra paint is cheap and idempotent.
