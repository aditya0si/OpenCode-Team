# Contributing

Thanks for the help. This project moves fast; if you're reading this,
the patterns probably already changed once.

## Setup

```bash
git clone https://github.com/aditya0si/OpenCode-Team
cd OpenCode-Team
bun install
bun run build
```

## Conventions

- **TypeScript** for the plugin entry, CLI, and templates loader.
- **Markdown + YAML frontmatter** for agent definitions, command
  templates, and pattern guides. Edit these in
  `src/cli/templates/`, not the dist (which is build output).
- **Prompts** are in `src/cli/templates/prompts/`. Each agent has one
  file: `orchestrator.txt`, `proposer.txt`, etc. The agent .md
  references the .txt with `{file:./prompts/team/<name>.txt}` —
  the plugin rewrites this to the absolute path at load time.
- **Bun** for the build (mirrors oh-my-opencode-slim). The
  `package.json` `bin` points at `dist/cli/index.js`, so npm
  install works too.
- **Two export shapes**: `default` (v1 plugin) and `setup`/`server`
  (v2 plugin). Keep both working.

## Adding a new agent

1. Drop the .md file in `src/cli/templates/` with YAML frontmatter
   (mode, model, temperature, color, permission, hidden, prompt path).
2. Add the corresponding .txt prompt body in
   `src/cli/templates/prompts/<name>.txt`.
3. Add the agent name to `AGENT_TEMPLATES` in `src/templates.ts`.
4. (If you want a slash command) Add a command .md in
   `src/cli/templates/commands/` and add the file to `COMMAND_FILES`
   in `src/templates.ts`.
5. Rebuild with `bun run build`.

## Adding a new pattern

1. Write `src/cli/templates/patterns/<name>.md`. Document: when to
   use, what changes in the run loop, what changes per role.
2. Add the name to the array in `getAllPatterns()` in
   `src/templates.ts`.
3. Update the orchestrator's pattern-picking table in
   `src/cli/templates/orchestrator.md`.
4. Rebuild.

## Adding a new preset

Edit `PRESETS` in `src/cli/index.ts`. The structure is:

```ts
{
  name: "preset-name",
  description: "One-line summary for the picker.",
  agents: {
    "team/orchestrator": "provider/model-id",
    "team/proposer":     "provider/model-id",
    // ... all 6
  },
}
```

## Testing

Currently manual. The smoke test is:

```bash
bun run build
bun dist/cli/index.js install --print
# Check that the printed JSON has the right shape.
```

Longer-term: a `scripts/smoke.ts` that runs the installer against
a temp dir and checks the resulting config.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/).
`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`. The release script
relies on these.

## Releases

```bash
# 1. One-time: log in to npm (creates ~/.npmrc with auth token)
npm login

# 2. Bump version
bun run release:patch   # or release:minor, release:major

# 3. Push tag (triggers GitHub Actions to publish to npm)
git push --follow-tags
```

The release workflow at `.github/workflows/release.yml` builds the
package, verifies the artifact, and publishes to npm with
provenance. It requires `NPM_TOKEN` to be set in the repo's GitHub
Secrets — see https://docs.npmjs.com/creating-and-viewing-access-tokens
for creating one.

For a manual publish (no CI):

```bash
bun run build
npm publish --provenance --access public
```
