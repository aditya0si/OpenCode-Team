import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "parse5";
import { landingContent } from "../src/content.mjs";
import { renderPage, readTemplate } from "../src/render.mjs";

function findAll(node, predicate, out = []) {
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes ?? []) findAll(child, predicate, out);
  return out;
}

function byTag(node, tagName) {
  return findAll(node, (n) => n.tagName === tagName);
}

function attr(node, name) {
  const a = (node.attrs ?? []).find((x) => x.name === name);
  return a ? a.value : undefined;
}

function textOf(node) {
  if (node.nodeName === "#text") return node.value;
  return (node.childNodes ?? []).map(textOf).join("");
}

function classNames(node) {
  return (attr(node, "class") ?? "").split(/\s+/).filter(Boolean);
}

const template = readTemplate();

test("single_main_and_h1", () => {
  const html = renderPage(landingContent, template);
  const doc = parse(html);
  assert.equal(byTag(doc, "main").length, 1);
  assert.equal(byTag(doc, "h1").length, 1);
  assert.equal(byTag(doc, "main")[0].tagName, "main");
});

test("required_fragments_and_skip_target_exist", () => {
  const html = renderPage(landingContent, template);
  const doc = parse(html);
  const ids = new Set(
    findAll(doc, (n) => n.tagName && attr(n, "id") !== undefined).map((n) => attr(n, "id")),
  );
  for (const id of [
    "main",
    "workflow",
    "patterns",
    "install",
    "configure",
    "commands",
    "release-status",
    "faq",
  ]) {
    assert.ok(ids.has(id), `expected fragment target #${id}`);
  }
  const skip = findAll(doc, (n) => n.tagName === "a" && attr(n, "class")?.includes("skip-link"));
  assert.equal(skip.length, 1);
  assert.equal(attr(skip[0], "href"), "#main");
});

test("examples_are_real_text_not_html", () => {
  const injected = JSON.parse(JSON.stringify(landingContent));
  injected.snippets.find((s) => s.id === "install-preview").text =
    "<script>alert('x')</script> & \"quotes\"";
  const html = renderPage(injected, template);
  assert.ok(!html.includes("<script>alert"), "snippet markup must be escaped, not executed");
  assert.ok(html.includes("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"));
  const doc = parse(html);
  const scripts = byTag(doc, "script");
  assert.equal(scripts.length, 1, "only the module enhancement script may exist");
  assert.equal(attr(scripts[0], "src"), "./assets/enhance.js");
});

test("copy_controls_hidden_until_enhanced", () => {
  const html = renderPage(landingContent, template);
  const doc = parse(html);
  const buttons = findAll(
    doc,
    (n) => n.tagName === "button" && attr(n, "class")?.includes("copy-button"),
  );
  assert.ok(buttons.length >= landingContent.snippets.length);
  for (const button of buttons) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(
        Object.fromEntries((button.attrs ?? []).map((a) => [a.name, a.value])),
        "hidden",
      ),
      "copy buttons must ship hidden",
    );
    const target = attr(button, "data-copy-target");
    assert.ok(target, "each copy button points at a target");
    const targetNode = findAll(doc, (n) => attr(n, "id") === target);
    assert.equal(targetNode.length, 1, `target #${target} must exist exactly once`);
  }
  const feedback = findAll(doc, (n) => attr(n, "class")?.includes("copy-feedback"));
  assert.equal(feedback.length, buttons.length);
  for (const node of feedback) {
    assert.equal(attr(node, "role"), "status");
    assert.equal(attr(node, "aria-live"), "polite");
  }
});

test("source_urls_not_local_repo_paths", () => {
  const html = renderPage(landingContent, template);
  const doc = parse(html);
  const anchors = findAll(doc, (n) => n.tagName === "a");
  for (const anchor of anchors) {
    const href = attr(anchor, "href") ?? "";
    const local = href.startsWith("#") || href.startsWith("./");
    const external = href.startsWith("https://");
    assert.ok(local || external, `unexpected href scheme: ${href}`);
    if (external) continue;
    // Local references must never point at repository source files.
    assert.ok(!href.startsWith("file:"), `no file: links (${href})`);
    assert.ok(!href.includes(".ts"), `no source .ts paths (${href})`);
    assert.ok(!href.includes("src/cli"), `no local source paths (${href})`);
  }
  const sourceLinks = anchors
    .map((a) => attr(a, "href") ?? "")
    .filter((href) => href.startsWith("https://"));
  assert.ok(sourceLinks.some((href) => href.includes("npmjs.com")), "npm link present");
  assert.ok(sourceLinks.some((href) => href.includes("github.com")), "github link present");
});

test("relative_assets_work_at_both_bases", () => {
  const html = renderPage(landingContent, template);
  const doc = parse(html);
  const assets = [
    ...findAll(doc, (n) => n.tagName === "link" && attr(n, "rel") === "stylesheet"),
    ...findAll(doc, (n) => n.tagName === "script"),
    ...findAll(doc, (n) => n.tagName === "link" && attr(n, "rel") === "icon"),
  ];
  assert.ok(assets.length >= 3);
  for (const node of assets) {
    const ref = attr(node, "href") ?? attr(node, "src");
    assert.ok(ref.startsWith("./assets/"), `asset must be relative: ${ref}`);
    assert.ok(!ref.startsWith("/"), `asset must not be root-absolute: ${ref}`);
  }
});

test("renderer_rejects_marker_problems", () => {
  const duplicate = template.replace("<!-- @hero -->", "<!-- @hero -->\n      <!-- @hero -->");
  assert.throws(() => renderPage(landingContent, duplicate), /duplicate marker/);

  const missing = template.replace("<!-- @faq -->", "");
  assert.throws(() => renderPage(landingContent, missing), /missing from the template/);

  const unknown = template.replace("<!-- @hero -->", "<!-- @hero -->\n      <!-- @nope -->");
  assert.throws(() => renderPage(landingContent, unknown), /unknown marker/);
});

test("renderer_rejects_duplicate_content_ids", () => {
  const duped = JSON.parse(JSON.stringify(landingContent));
  duped.snippets.push({ ...duped.snippets[0] });
  assert.throws(() => renderPage(duped, template), /duplicate snippets id/);
});

test("hero_lanes_are_semantic_ordered_list_without_duplicate_text", () => {
  const html = renderPage(landingContent, template);
  const doc = parse(html);

  const laneLists = findAll(
    doc,
    (n) => n.tagName === "ol" && classNames(n).includes("handoff-lanes"),
  );
  assert.equal(laneLists.length, 1, "the handoff lanes must be one ordered list");
  const items = findAll(laneLists[0], (n) => n.tagName === "li");
  assert.equal(items.length, landingContent.illustration.steps.length);
  const labels = items.map((li) => {
    const span = findAll(
      li,
      (n) => n.tagName === "span" && classNames(n).includes("lane-label"),
    )[0];
    return span ? textOf(span) : "";
  });
  assert.deepEqual(
    labels,
    landingContent.illustration.steps.map((s) => s.label),
    "lane order is task brief -> coordinate -> work -> review",
  );

  // The old duplicate visible ordered text list must be gone.
  assert.equal(
    findAll(doc, (n) => classNames(n).includes("handoff-text")).length,
    0,
    "no duplicate visible text list",
  );

  // Decorative connectors are hidden from assistive technology.
  const bracket = findAll(doc, (n) => classNames(n).includes("handoff-bracket"));
  assert.equal(bracket.length, 1);
  assert.equal(attr(bracket[0], "aria-hidden"), "true");

  const feedback = findAll(doc, (n) => classNames(n).includes("handoff-feedback"));
  assert.equal(feedback.length, 1);
  assert.match(textOf(feedback[0]), /Revise after findings/);

  const caption = findAll(doc, (n) => classNames(n).includes("handoff-caption"));
  assert.equal(caption.length, 1);
  assert.match(textOf(caption[0]), /Illustrative workflow, not a live run/);
});

function orderedInstallNodes(doc) {
  return findAll(
    doc,
    (n) => classNames(n).includes("warning") || attr(n, "data-snippet") !== undefined,
  );
}

test("uninstall_data_loss_warning_precedes_command", () => {
  const doc = parse(renderPage(landingContent, template));
  const nodes = orderedInstallNodes(doc).filter(
    (n) => n.tagName === "p" || attr(n, "data-snippet") !== undefined,
  );
  const idx = nodes.findIndex((n) => attr(n, "data-snippet") === "uninstall");
  assert.ok(idx > 0, "the uninstall snippet exists and is not first");

  const immediate = nodes[idx - 1];
  assert.equal(immediate.tagName, "p", "a warning paragraph immediately precedes the command");
  assert.ok(classNames(immediate).includes("warning"));
  const text = textOf(immediate);
  for (const key of ["provider", "theme", "permission"]) {
    assert.match(text, new RegExp(key, "i"), `data-loss warning must name ${key}`);
  }
  assert.match(text, /back up/i);
  assert.match(text, /restore/i);
});

test("config_runtime_warning_is_adjacent_to_json_example", () => {
  const doc = parse(renderPage(landingContent, template));
  const nodes = orderedInstallNodes(doc);
  const idx = nodes.findIndex((n) => attr(n, "data-snippet") === "config-json");
  assert.ok(idx >= 0, "the JSON configuration example exists");
  const next = nodes[idx + 1];
  assert.ok(next, "a warning must immediately follow the JSON example");
  assert.equal(next.tagName, "p");
  assert.ok(classNames(next).includes("warning"));
  assert.match(textOf(next), /not effective runtime/i);
});
