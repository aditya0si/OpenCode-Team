---
name: Bug report
about: Something is broken with opencode-team
title: '[bug] '
labels: bug
assignees: aditya0si
---

## What happened

<!-- A clear description. If it's a wrong-model error, paste the model
     assignment from your opencode.json. If it's a hang, paste the
     last 50 lines of the orchestrator's output. -->

## What you expected

## Reproduction

```bash
# The exact command you ran
opencode-team install --preset team
```

## Environment

- OS: [e.g. macOS 15.2, Windows 11, Ubuntu 24.04]
- opencode version: [run `opencode --version`]
- opencode-team version: [run `bunx opencode-team@latest --version`]
- Node version: [run `node --version`]
- Bun version: [run `bun --version`]

## opencode.json

```jsonc
// paste the relevant section, redact secrets
{
  "plugin": [...],
  "agent": { ... }
}
```

## Anything else

<!-- Screenshots, logs, the .teamwork-runs/<run-id>/ if it's a run issue. -->
