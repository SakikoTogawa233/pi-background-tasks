---
doc_id: choose-a-workflow
audience: user
mode: authored
review_policy: contract
stability: stable
covers_surfaces: []
covers_sources: []
---
# Choose a workflow

## Quick decision tree

1. **Is the work short and interactive?** Use ordinary foreground Pi work. In the TUI, `Ctrl+B` can hand off a foreground `bash` command that unexpectedly runs long.
2. **Is it expected to be a long shell command?** Use `/bg` if you are typing it; use `bg_run` if the agent is launching it. Do not rely on the foreground fallback as the planned launch path.
3. **Does a second agent need this conversation as context while the parent continues?** Use `bg_delegate`, then `bg_result` after completion.
4. **Do you need local evidence from one direct Pi child run?** Use `bg_run_pi_attested`.
5. **Do you want multiple model perspectives on one fixed-purpose prompt?** Use the matching Fusion tool.

## Comparison table

| Option | Sync/async | Context sent | Can read repo? | Can use network? | Can write? | Route behavior | Use when |
|---|---|---|---:|---:|---:|---|---|
| Foreground work | Synchronous; interactive `bash` can be handed off | Current session | Depends on active tools | Depends on active tools | Depends on active tools | Current session route | You need live interaction; `Ctrl+B` is an escape hatch for an unexpectedly long bash command. |
| `/bg` | Async | None by package | Command decides | Command decides | Command decides | Not a model route unless command invokes one | You manually start a long local command. |
| `bg_run` | Async | None by package | Command decides | Command decides | Command decides | Not a model route unless command invokes one | Pi should launch a long command and resume later. |
| `bg_delegate` + `bg_result` | Async launch, point-in-time retrieval | Frozen visible conversation projection | Yes, inspect-only model tools; ambient extension code is not sandboxed | No | No | Pinned at launch; no substitution | Context-aware read-only investigation; isolated extension discovery by default. |
| `bg_run_pi_attested` | Async | Prompt only | Child Pi decides from prompt/tools | Child Pi route/tools decide | Report path requested | Structured provider/model; OAuth observed for supported subscription routes | Local evidence-producing Pi run. |
| `fusion_reason` / `/fusion` | Async launch, point-in-time `bg_result` retrieval | Versioned conversation projection plus prompt | No | No | No | Configured Fusion slots; no silent fallback | Self-contained reasoning/synthesis. |
| `fusion_investigate` | Async launch, point-in-time `bg_result` retrieval | Clean task input only | Candidate read-only tools | No | No | Configured Fusion slots; no silent fallback | Independent repository investigation. |
| `fusion_research` | Async launch, point-in-time `bg_result` retrieval | Clean task input only | Candidate read-only tools | Only declared public URLs | No | Configured Fusion slots; no silent fallback | Targeted URL-backed synthesis, not search. |
| `fusion_validate` | Async launch, point-in-time `bg_result` retrieval | Clean task input only | Candidate read-only tools | No | No | Configured Fusion slots; no silent fallback | Advisory review of completed work. |

## Tradeoffs and boundaries

### Foreground vs background shell

Foreground commands are best when the next answer depends on immediate output. Background commands are best when the command may take long enough that Pi can do other useful work or yield until completion.

In interactive TUI mode, the package's foreground `bash` override shows a `Ctrl+B` hint after 2 seconds and automatically adopts an eligible command after 120 seconds of total runtime. The same live process and output file continue as a normal task. This behavior is disabled in non-interactive modes. Planned long work should still use `/bg` or `bg_run` explicitly so task identity and delivery semantics exist from launch.

`/bg`, `bg_run`, and the foreground `bash` override are not sandboxes. They spawn local shell commands with the permissions, environment, network access, and credentials available to the Pi process. A background command can itself call paid services.

### `bg_run` defaults

`bg_run` requires:

```json
{"name":"Short label","command":"shell command","isAgent":false}
```

Defaults are `notifyOnCompletion:true` and `triggerOnCompletion:true`. With those defaults, Pi should not poll `bg_status` or `bg_logs` merely to wait.

### Delegate boundaries

`bg_delegate` supports only `capability:"inspect"`. The child is seeded with a deterministic visible-conversation projection, but omitted parent tool payloads are not available. Restate any needed facts in the delegate prompt.

Extension discovery defaults to `extensionMode:"isolated"`. Select `"ambient"` only for a provider registered by an ambient user/project extension. Ambient mode executes arbitrary extension code, so its process is not inspect-only sandboxed even though its model-visible tools remain read/search/list only. It accepts no extension paths and never substitutes the route.

Use `bg_result` for retrieval. It verifies hashes before returning content and reports oversized answers as artifacts instead of silently truncating.

### Fusion boundaries

Fusion is a fixed workflow, not a free-form mode switch:

1. Three candidate child Pi runs.
2. One blind evaluator.
3. One bounded conditional evaluator repair only if the evaluator JSON is invalid.
4. One merger.

`fusion_research` performs targeted retrieval of caller-supplied public URLs. It does not search the web, browse arbitrary links, fetch private URLs, or treat fetched content as instructions.

## Examples

### Long command

```json
{"name":"Build watch","command":"npm run build -- --watch","isAgent":false,"timeoutSeconds":7200}
```

### Delegate investigation

```json
{
  "name": "Docs locator",
  "prompt": "Find the docs that explain shell selection and update checks. Return exact file paths and a concise summary.",
  "capability": "inspect",
  "extensionMode": "isolated"
}
```

### Fusion validation

```json
{
  "objective": "Review docs readiness",
  "background": ["Only package-local Markdown and image assets changed."],
  "changeSummary": "README became a landing page; detailed setup moved into docs.",
  "scope": ["README.md", "docs"],
  "acceptanceCriteria": ["Links resolve", "Examples match schemas", "Safety caveats are explicit"],
  "verification": {"status":"not_run", "reason":"Manual review requested before checks."}
}
```
