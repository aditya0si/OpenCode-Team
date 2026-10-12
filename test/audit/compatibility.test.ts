/**
 * Task 0 compatibility tests.
 *
 * Two layers:
 *  1. Deterministic, offline unit tests for `runBounded` — the bounded child
 *     runner that replaced the unbounded `new Response(proc.stdout).text()`
 *     wait whose grandchild-held pipe caused an 80-minute hang.
 *  2. Black-box probes against the *actual installed* OpenCode host
 *     (`opencode agent list` in an isolated HOME/config). These do not invoke a
 *     model/provider; they only load the plugin and enumerate agents.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  ADAPTER_ENTRY,
  COMPAT_DIR,
  DIRECT_ENTRY,
  DEFAULT_TIMEOUT_MS,
  observePluginLoad,
  pluginSpec,
  runBounded,
  writeProbeModule,
} from "../../scripts/audit-compatibility.ts";

const BUN_BIN = process.execPath;

describe("runBounded", () => {
  test(
    "returns quickly when a grandchild holds the stdout pipe open after the parent exits",
    async () => {
      const grandchildHolder =
        "const { spawn } = require('node:child_process');" +
        " spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 3000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();" +
        " process.exit(0);";
      const started = Date.now();
      const result = await runBounded(BUN_BIN, ["-e", grandchildHolder], { timeoutMs: 4_000 });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(8_000);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
    },
    30_000,
  );

  test(
    "hard-times-out a child that never exits",
    async () => {
      const started = Date.now();
      const result = await runBounded(BUN_BIN, ["-e", "setInterval(() => {}, 1000)"], {
        timeoutMs: 1_500,
      });
      const elapsed = Date.now() - started;
      expect(result.timedOut).toBe(true);
      expect(elapsed).toBeLessThan(15_000);
    },
    30_000,
  );

  test(
    "caps captured output and flags truncation",
    async () => {
      const result = await runBounded(
        BUN_BIN,
        ["-e", "process.stdout.write('x'.repeat(500000)); process.stderr.write('y'.repeat(500000));"],
        { timeoutMs: 15_000, maxBytes: 4_096 },
      );
      expect(result.timedOut).toBe(false);
      expect(result.truncated).toBe(true);
      expect(result.stdout.length).toBeLessThanOrEqual(4_096);
      expect(result.stderr.length).toBeLessThanOrEqual(4_096);
    },
    30_000,
  );
});

describe("plugin entry export shape", () => {
  test("the default adapter exports only a function", async () => {
    const module = (await import(pluginSpec(ADAPTER_ENTRY))) as Record<string, unknown>;
    expect(Object.keys(module)).toEqual(["default"]);
    expect(typeof module.default).toBe("function");
  });

  test("the library entry keeps its non-function named exports", async () => {
    const module = (await import(pluginSpec(DIRECT_ENTRY))) as Record<string, unknown>;
    // These are exactly the exports the host loader rejects: it requires every
    // export to be a function. They must remain for library consumers.
    expect(typeof module.id).toBe("string");
    expect(typeof module.DEFAULT_POLICY).toBe("object");
    expect(typeof module.default).toBe("function");
  });
});

describe("actual installed host plugin load", () => {
  test(
    "direct dist/index.js is rejected (non-function export)",
    async () => {
      const observation = await observePluginLoad("test-direct-entry", pluginSpec(DIRECT_ENTRY));
      expect(observation.timedOut).toBe(false);
      expect(observation.loaded).toBe(false);
      expect(observation.loadErrorMessage).toBe("Plugin export is not a function");
      expect(observation.teamAgents).toHaveLength(0);
    },
    60_000,
  );

  test(
    "default-export-only adapter loads all 10 team agents",
    async () => {
      const observation = await observePluginLoad("test-adapter-entry", pluginSpec(ADAPTER_ENTRY));
      expect(observation.timedOut).toBe(false);
      expect(observation.loaded).toBe(true);
      expect(observation.loadErrorMessage).toBeNull();
      expect(observation.teamAgents).toHaveLength(10);
      expect(observation.teamAgents).toContain("team/verifier");
    },
    60_000,
  );

  test(
    "a wrapper adding a non-function named export is rejected",
    async () => {
      const wrapper = writeProbeModule(
        "test-unsafe-wrapper",
        `import real from ${JSON.stringify(pluginSpec(ADAPTER_ENTRY))};\nexport default real;\nexport const meta = { unsafe: true };\n`,
      );
      const observation = await observePluginLoad("test-unsafe-wrapper", pluginSpec(wrapper));
      expect(observation.timedOut).toBe(false);
      expect(observation.loaded).toBe(false);
      expect(observation.loadErrorMessage).toBe("Plugin export is not a function");
    },
    60_000,
  );

  test(
    "a non-function default export is rejected",
    async () => {
      const malformed = writeProbeModule("test-malformed-default", "export default 42;\n");
      const observation = await observePluginLoad("test-malformed-default", pluginSpec(malformed));
      expect(observation.timedOut).toBe(false);
      expect(observation.loaded).toBe(false);
      expect(observation.loadErrorMessage).toBe("Plugin export is not a function");
    },
    60_000,
  );

  test("harness paths stay inside audit-build/compatibility", () => {
    expect(COMPAT_DIR.startsWith(join(process.cwd(), "audit-build", "compatibility"))).toBe(true);
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
