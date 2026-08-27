# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | yes |

## Reporting a vulnerability

Email **aditya0si@users.noreply.github.com** or open a private
security advisory at
https://github.com/aditya0si/OpenCode-Team/security/advisories/new.

Please **do not** open a public issue for security problems.

We aim to respond within 72 hours.

## Threat model

opencode-team is a plugin that injects agent definitions and slash
commands into your opencode instance. The threats we care about:

1. **Prompt injection** — a malicious repository or document could
   attempt to influence the team via the scout's `webfetch`. The
   falsifier's role is partially to catch this: a candidate that
   obeys the document instead of the user is a FATAL finding.
2. **Permission escalation** — the agent .md files set permissions
   (edit, bash, webfetch, task). A user who installs the plugin
   should review these. The proposer asks for `edit: ask` and
   `bash: ask` (not allow) by default. The orchestrator has
   `allow` because it dispatches but does not edit code itself.
3. **Cost amplification** — Teamwork spends many tokens. The
   per-pattern round caps (3-6) are there for a reason. Bumping
   them in your config is fine; doing so in the plugin source is a
   PR-worthy change.
4. **Outbound network** — the scout and falsifier may `webfetch`
   external URLs. The `webfetch: deny` permission on the verifier
   means the verifier can't phone home during a check.

## What we do NOT do

- We do not exfiltrate your opencode config, your conversations, or
  your code to any server.
- We do not phone home. There is no telemetry in the plugin.
- We do not require any account. `opencode-team install` is a
  one-time config write; after that, the plugin runs entirely
  locally against your opencode.
