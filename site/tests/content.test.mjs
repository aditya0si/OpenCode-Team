import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { landingContent, validateContent } from "../src/content.mjs";
import {
  commitExists,
  releaseFile,
  releaseFileNames,
  releaseJson,
  parsePresetNames,
  releasePresetNames,
} from "../scripts/release-evidence.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/release-contract.json", import.meta.url), "utf-8"),
);

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function ids(items) {
  return items.map((item) => item.id);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function collectStrings(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

test("release_identity_is_preserved", () => {
  assert.equal(landingContent.documentedRelease, fixture.documentedRelease);
  assert.equal(landingContent.releaseCommit, fixture.releaseCommit);
  assert.equal(landingContent.documentedRelease, "0.2.1");
  assert.equal(landingContent.releaseCommit, "70c1dbaa07819f0b9612f032d27ca5ffd626fe04");
  assert.doesNotThrow(() => validateContent(landingContent));
});

test("declared_release_commit_exists", () => {
  assert.match(fixture.releaseCommit, /^[0-9a-f]{40}$/);
  assert.ok(
    commitExists(fixture.releaseCommit),
    `declared release commit must exist in this repository: ${fixture.releaseCommit}`,
  );
});

test("inventories_match_reviewed_source_at_release_commit", () => {
  assert.deepEqual(ids(landingContent.roles), fixture.roleIds);
  assert.deepEqual(ids(landingContent.commands), fixture.commandIds);
  assert.deepEqual(ids(landingContent.patterns), fixture.patternIds);
  assert.equal(landingContent.roles.length, 10);
  assert.equal(landingContent.commands.length, 7);
  assert.equal(landingContent.patterns.length, 6);

  // Cross-check the fixture against the committed release tree, read with
  // read-only git plumbing. The working tree is deliberately ignored: the
  // repository is currently dirty and an uncommitted edit must never redefine
  // what counts as "released".
  const commit = fixture.releaseCommit;
  assert.ok(commitExists(commit), `release commit must exist: ${commit}`);

  const roleFiles = releaseFileNames(commit, "src/cli/templates")
    .filter((f) => f.endsWith(".md"))
    .map((f) => `team/${f.replace(/\.md$/, "")}`)
    .sort();
  assert.deepEqual(roleFiles, [...fixture.roleIds].sort());

  const commandFiles = releaseFileNames(commit, "src/cli/templates/commands")
    .filter((f) => f.endsWith(".md"))
    .map((f) => `/${f.replace(/\.md$/, "")}`)
    .sort();
  assert.deepEqual(commandFiles, [...fixture.commandIds].sort());

  const patternFiles = releaseFileNames(commit, "src/cli/templates/patterns")
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
  assert.deepEqual(patternFiles, [...fixture.patternIds].sort());

  const pkg = releaseJson(commit, "package.json");
  assert.equal(pkg.name, fixture.packageName);
  assert.equal(pkg.version, fixture.documentedRelease);

  // Presets are evidence too: they must come from the committed CLI, not from
  // the dirty working tree (which adds unpublished opencode-* presets).
  assert.deepEqual(releasePresetNames(commit), fixture.presetIds);
});

test("working_tree_mutation_cannot_redefine_release_evidence", () => {
  const commit = fixture.releaseCommit;
  assert.ok(commitExists(commit));

  const committedCli = releaseFile(commit, "src/cli/index.ts");
  assert.deepEqual(
    parsePresetNames(committedCli),
    fixture.presetIds,
    "the committed CLI must list exactly the released presets",
  );

  const scratchRoot = join(REPO_ROOT, "site", "test-results", "release-evidence");
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, "scratch-"));
  try {
    // Simulate an uncommitted working-tree edit that adds an unreleased preset.
    const mutated = committedCli.replace(
      "const PRESETS: Preset[] = [",
      'const PRESETS: Preset[] = [\n  { name: "unreleased-decoy", description: "x", agents: {} },',
    );
    writeFileSync(join(scratch, "index.ts"), mutated, "utf-8");

    const mutatedNames = parsePresetNames(readFileSync(join(scratch, "index.ts"), "utf-8"));
    assert.notDeepEqual(
      mutatedNames,
      fixture.presetIds,
      "the mutated working copy must be visibly different from the release",
    );
    assert.ok(mutatedNames.includes("unreleased-decoy"));

    // The release reader ignores the working copy entirely.
    assert.deepEqual(releasePresetNames(commit), fixture.presetIds);
    assert.deepEqual(ids(landingContent.roles).sort(), releaseFileNames(commit, "src/cli/templates")
      .filter((f) => f.endsWith(".md"))
      .map((f) => `team/${f.replace(/\.md$/, "")}`)
      .sort());
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("install_examples_use_released_preset", () => {
  const byId = Object.fromEntries(landingContent.snippets.map((s) => [s.id, s]));
  assert.equal(byId["install-preview"].text, fixture.installPreview);
  assert.equal(byId["install-write"].text, fixture.installWrite);
  assert.equal(byId["install-bunx"].text, fixture.installBunx);
  assert.equal(byId["launch-opencode"].text, fixture.launch);

  for (const [id, snippet] of Object.entries(byId)) {
    if (!id.startsWith("install-")) continue;
    assert.ok(snippet.text.includes("--preset anthropic"), `${id} should use the anthropic preset`);
    assert.ok(snippet.text.includes("@0.2.1"), `${id} should pin the installer version`);
    for (const forbidden of fixture.forbiddenInReleasedInstall) {
      assert.ok(
        !snippet.text.includes(forbidden),
        `${id} must not advertise "${forbidden}" as a released example`,
      );
    }
  }

  assert.deepEqual(fixture.presetIds, ["anthropic", "team", "google", "openai", "free"]);
  // The advertised presets are exactly the presets committed in the release,
  // never the unpublished opencode-* presets present in the dirty working tree.
  assert.deepEqual(releasePresetNames(fixture.releaseCommit), fixture.presetIds);
});

test("installer_pin_warning_is_required", () => {
  const { warnings } = landingContent;
  assert.ok(warnings.installerPin.includes(fixture.installerWrites));
  assert.ok(warnings.installerPin.includes(fixture.pluginPin));
  assert.match(warnings.pluginArray, /replace the plugin array/i);
  assert.match(warnings.pluginArray, /back up/i);
  assert.match(warnings.preview, /proposed patch/i);
  assert.match(warnings.doctor, /does not test/i);
  assert.match(warnings.resetYes, /--reset/);
  assert.match(warnings.uninstall, /configuration/i);
});

test("configuration_is_valid_complete_json", () => {
  const snippet = landingContent.snippets.find((s) => s.id === "config-json");
  assert.ok(snippet, "a config-json snippet is required");
  assert.equal(snippet.language, "json");

  const parsed = JSON.parse(snippet.text);
  assert.deepEqual(parsed.plugin, [fixture.pluginPin]);

  const agentRoles = Object.keys(parsed.agent).sort();
  assert.deepEqual(agentRoles, [...fixture.roleIds].sort());
  for (const role of fixture.roleIds) {
    assert.equal(
      parsed.agent[role].model,
      fixture.anthropicModel,
      `${role} must use the literal anthropic model id`,
    );
  }
});

test("development_never_appears_as_released", () => {
  const devRow = landingContent.releaseRows.find((r) => r.status === "development");
  assert.ok(devRow, "a development release row is required");
  assert.match(devRow.text, /unpublished/i);

  for (const snippet of landingContent.snippets) {
    assert.ok(
      !snippet.text.includes("0.3.0"),
      `snippet ${snippet.id} must not advertise the unpublished development version`,
    );
  }

  assert.match(landingContent.links.development.label, /development/i);
  assert.match(landingContent.links.development.href, /teamwork-review-build/);
});

test("runtime_model_configuration_is_not_promised_as_effective", () => {
  // The 0.2.1 config hook replaces every team role with { prompt: body }, so a
  // per-role model/temperature in JSON does not govern runtime behavior. The
  // site must disclose this everywhere it discusses model selection.
  assert.equal(fixture.runtimeModelConfigEffective, false);

  const runtime = landingContent.warnings.runtimeModel ?? "";
  assert.match(runtime, /not effective runtime/i);
  assert.match(runtime, /config hook/i);
  assert.match(runtime, /prompt/i);
  assert.match(runtime, /host defaults/i);

  const configureSection = landingContent.sections.find((s) => s.id === "configure");
  const configure = configureSection.paragraphs.join(" ");
  assert.match(configure, /config hook/i);
  assert.match(configure, /do(es)? not govern runtime/i);

  const faq = landingContent.faq.find((f) => /select different models/i.test(f.question));
  assert.ok(faq, "the model-selection FAQ must remain");
  assert.match(faq.answer, /config hook|not effective|host defaults/i);

  for (const text of collectStrings(landingContent)) {
    assert.ok(
      !/replace its model value/i.test(text),
      `stale promise that editing JSON sets runtime models: ${text}`,
    );
  }
});

test("published_provenance_is_not_claimed", () => {
  // The published registry artifact's gitHead differs from the local release
  // commit. Reviewed behavior matches the source; provenance equality must not
  // be asserted anywhere in the page copy.
  for (const text of collectStrings(landingContent)) {
    assert.ok(
      !/(byte[- ]identical|identical provenance|same build as|provenance equality)/i.test(
        text,
      ),
      `provenance equality claim is not allowed: ${text}`,
    );
  }
});

test("uninstall_warning_discloses_dropped_keys_and_restore_guidance", () => {
  const warning = landingContent.warnings.uninstallDataLoss ?? "";
  for (const key of fixture.uninstallDroppedKeys) {
    assert.match(warning, new RegExp(key, "i"), `uninstall warning must name ${key}`);
  }
  assert.match(warning, /back up/i);
  assert.match(warning, /restore/i);
});

test("unsafe_configuration_promises_are_rejected", () => {
  for (const claim of ["guaranteed isolation", "enforced budget", "resume-safe engine"]) {
    const bad = clone(landingContent);
    bad.sections[0].paragraphs.push(`This release provides ${claim} for every run.`);
    assert.throws(
      () => validateContent(bad),
      /forbidden claim/,
      `validateContent should reject "${claim}"`,
    );
  }
});
