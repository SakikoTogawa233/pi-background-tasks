---
doc_id: reference/shortcuts-and-dock
audience: user
mode: mixed
review_policy: contract
stability: stable
covers_surfaces: ['shortcut:ctrl+alt+c', 'shortcut:ctrl+b', 'shortcut:shift+down']
covers_sources: []
---
# Shortcuts and dock

<!-- pi-docs:begin name="shortcut-contracts" generator="scripts/docs/generate.mjs" -->
| Shortcut | Description | Provenance |
| --- | --- | --- |
| `ctrl+alt+c` | Clear finished background task footer notices (terminal-dependent fallback for /bg-clear) | `src/extension.ts:598` |
| `ctrl+b` | Move the most recent active foreground bash command to the background | `src/core/foreground-bash.ts:641` |
| `shift+down` | Open focused background task footer dock | `src/extension.ts:591` |
<!-- pi-docs:end name="shortcut-contracts" -->

`Ctrl+B` hands off the newest eligible foreground Bash call. `Shift+Down` opens the one focused task dock. `/bg-clear` is the terminal-independent clear path; `Ctrl+Alt+C` is an optional fallback.
