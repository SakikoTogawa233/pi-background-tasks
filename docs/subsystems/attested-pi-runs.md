---
doc_id: subsystems/attested-pi-runs
audience: maintainer
mode: authored
review_policy: behavioral
stability: evolving
covers_surfaces: []
covers_sources: [src/core/attested-pi-run.ts]
---
# Attested Pi runs subsystem

This document is the primary behavioral owner for `src/core/attested-pi-run.ts`.

It does **not** claim ownership of shared registry, Pi-launch, common task, or durable-fs modules. Those modules spawn the prepared request, store task metadata, publish terminal state, and provide atomic write primitives used by this subsystem.

## Purpose

Attested Pi runs are opt-in local-evidence tasks for a structured child Pi invocation. They are intended for cases where an operator wants local hashes and observed route/auth/session facts, not just a background output file.

They do not replace ordinary `bg_run`, and they do not provide remote cryptographic proof.

## Structured request and argv

The request shape is:

- `name`
- `provider`
- `model`
- `prompt`
- `reportPath`
- optional `extraPiArgs`
- optional `thinking`
- optional `timeoutSeconds`

Validation rejects blank `name`, `provider`, `model`, `reportPath`, and empty `prompt`. `reportPath` must resolve inside task cwd and may not target `.git` or `.pi/tasks`.

The logical argv always begins:

```text
pi --mode json --provider <provider> --model <model>
```

Then optional `--thinking <thinking>`, then literal `extraPiArgs`, then the prompt as the final user prompt argument. Forbidden extra args are direct auth (`--api-key`, `--auth-file`), mode/print (`-p`, `--print`, `--mode`), and duplicate structured fields (`--provider`, `--model`, `--thinking`).

The registry launches exactly one child through the resolved Pi executable with `shell:false`. The attestation records the stable logical argv (`['pi', ...]`), not platform-specific Windows Node/CLI shims. Attested tasks are created with generic background completion notification/wake disabled; terminal snapshots are still published through the task system.

## Auth and environment boundary

The child environment removes direct/metered API configuration:

- `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`
- `OPENAI_API_KEY`, `OPENAI_BASE_URL`
- `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`
- `PI_API_KEY`, `PI_API_BASE_URL`, `PI_AUTH_FILE`

The producer observes auth through the model registry before spawn. The selected model must exist and `ModelRegistry.isUsingOAuth(selected)` must be available and true. Current accepted provider classes are:

- `openai-codex` → `pi-codex-oauth`, `subscription-codex`;
- `anthropic` → `pi-anthropic-oauth`, `subscription-anthropic`.

Any unsupported provider or non-OAuth route fails before attestation.

## Event parsing and observed route

Raw child stdout is captured as Pi JSON events. A successful stream must be newline-terminated and contain:

- exactly one `session` with id/cwd;
- exactly one `agent_start`;
- at least one assistant `message_end`;
- exactly one `agent_end`;
- the last assistant `stopReason` value reported in the stream is `stop`; messages that omit `stopReason` do not replace an earlier reported value;
- stable assistant provider/model across assistant messages;
- no assistant error.

The parsed provider/model must match the model selected from the registry. Token usage, cost total when present, tool usage, and a human transcript are derived from these events.

## Git authority

Before spawn, the subsystem records:

- git `HEAD` commit;
- git `HEAD^{tree}`;
- `git status --porcelain=v1 --untracked-files=all` cleanliness;
- repository root realpath;
- cwd realpath.

The worktree must be clean at start. On successful child completion, finish commit/tree/cleanliness are checked again. Changed commit/tree or dirty worktree prevents attestation.

## Files and hashes

Runtime paths are allocated by the background registry under `.pi/tasks/<session-id>-<pid>/`:

- `<task-id>.output`
- `<task-id>.json`
- `<task-id>.pi-events.jsonl`
- `<task-id>.stderr`
- `<task-id>.pi-telemetry-wrapper.cjs`
- `<task-id>.attestation.json`

The wrapper file is a note that the task is direct-spawned and no shell telemetry wrapper is used. The sidecar hashes metadata, output, events, stderr, wrapper, prompt bytes, and the required report file.

The sidecar schema is `phase2.pi_task_attestation.v1`. It includes locator, source hashes, lifecycle, invocation/auth facts, git authority, artifact hashes, and a self hash (`attestation_sha256`) over canonical sidecar content excluding that self field.

## Durability and visibility

Initial output/events/stderr/wrapper files and metadata are created before spawn. On close, stdout/stderr buffers are fsynced to the events/stderr files. Successful event parsing rewrites task output from the parsed transcript; failures write diagnostics/stderr output.

For a completed child with parsed events, the registry asks this subsystem to build the attestation, then writes `<task-id>.attestation.json` using durable atomic replacement. Only after that write returns does the registry set in-memory `task.status` to `completed` and publish terminal state. The metadata file may receive a completed snapshot earlier in this path; terminal in-memory/UI visibility is held until after sidecar durability.

## Failure and no-partial-sidecar behavior

No successful sidecar is emitted when:

- request validation fails;
- route/auth observation fails;
- worktree is dirty at start;
- child spawn fails;
- child exits non-zero, times out, or is killed;
- stdout events are malformed, incomplete, not newline-terminated, route-drifted, or the last reported assistant stop reason is not `stop`;
- the expected report file is missing/unreadable;
- git authority changes or finish worktree is dirty;
- attestation construction or durable sidecar write fails.

Raw evidence files remain for diagnosis. Sidecar final-name writes use atomic replacement, so ordinary write failures do not create a truncated final sidecar that looks complete. If sidecar construction/write fails after earlier metadata work, the task is marked failed.

## Trust boundary

The sidecar is unsigned local evidence in a same-user-writable working tree/task store. It states what this extension observed and hashed locally. It is not a signature, not tamper-proof, not a remote cryptographic proof, and not evidence against an attacker who can modify the repository or `.pi/tasks` artifacts.

## Maintainer checklist

When changing this subsystem, re-check:

- forbidden auth/mode/provider/model/thinking args;
- OAuth-only observation and provider class mapping;
- stripped metered environment keys;
- JSON event strictness and route consistency;
- git clean/commit/tree checks at start and finish;
- prompt/report/events/stderr/output/wrapper/metadata hash coverage;
- sidecar write ordering relative to terminal visibility;
- no sidecar on failure paths.
