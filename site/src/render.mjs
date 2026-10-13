// Deterministic HTML renderer for the opencode-teamwork landing page.
//
// renderPage(content, template) fills named insertion markers in the template
// with escaped, semantic HTML built from the reviewed content module. All
// authored text and snippets are escaped as text; nothing in content is
// treated as executable markup.

import { readFileSync } from "node:fs";

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function assertUniqueIds(items, label) {
  const seen = new Set();
  for (const item of items ?? []) {
    if (!item || typeof item.id !== "string") {
      throw new Error(`renderPage: ${label} entry is missing a string id`);
    }
    if (seen.has(item.id)) {
      throw new Error(`renderPage: duplicate ${label} id "${item.id}"`);
    }
    seen.add(item.id);
  }
}

function snippetById(content, id) {
  const snippet = (content.snippets ?? []).find((s) => s.id === id);
  if (!snippet) throw new Error(`renderPage: missing required snippet "${id}"`);
  return snippet;
}

function renderSnippet(snippet) {
  const targetId = `snippet-${snippet.id}`;
  const copyLabel = snippet.copyLabel ?? `Copy ${snippet.label}`;
  return `        <figure class="snippet" data-snippet="${escapeAttr(snippet.id)}">
          <figcaption class="snippet-head">
            <span class="snippet-label">${escapeHtml(snippet.label)}</span>
            <button type="button" class="copy-button" data-copy-target="${escapeAttr(
              targetId,
            )}" hidden>${escapeHtml(copyLabel)}</button>
            <span class="copy-feedback" role="status" aria-live="polite"></span>
          </figcaption>
          <pre class="code" data-language="${escapeAttr(snippet.language)}" tabindex="0" aria-label="${escapeAttr(
            `Code: ${snippet.label}`,
          )}"><code id="${escapeAttr(targetId)}">${escapeHtml(snippet.text)}</code></pre>
        </figure>`;
}

function renderSnippets(content, ids) {
  return ids.map((id) => renderSnippet(snippetById(content, id))).join("\n");
}

function navSection(content, id) {
  const section = (content.sections ?? []).find((s) => s.id === id);
  if (!section) throw new Error(`renderPage: missing required section "${id}"`);
  return section;
}

function renderSkip() {
  return `    <a class="skip-link" href="#main">Skip to main content</a>`;
}

function renderHeader(content) {
  const navIds = ["workflow", "install", "configure", "release-status"];
  const items = navIds
    .map((id) => {
      const section = navSection(content, id);
      return `          <li><a href="#${escapeAttr(id)}">${escapeHtml(section.navLabel ?? id)}</a></li>`;
    })
    .join("\n");
  const source = content.links.repository;
  return `    <header class="site-header">
      <a class="wordmark" href="./index.html">opencode-teamwork</a>
      <nav class="site-nav" aria-label="Primary">
        <ul>
${items}
        </ul>
      </nav>
      <a class="header-source" href="${escapeAttr(source.href)}">GitHub</a>
    </header>`;
}

function renderHero(content) {
  const { hero, illustration } = content;
  const lanes = illustration.steps
    .map(
      (step) => `              <li class="lane">
                <span class="lane-label">${escapeHtml(step.label)}</span>
                <span class="lane-responsibility">${escapeHtml(step.responsibility)}</span>
              </li>`,
    )
    .join("\n");
  return `      <section class="hero" aria-labelledby="hero-heading">
        <div class="hero-copy">
          <h1 id="hero-heading">${escapeHtml(hero.headline)}</h1>
          <p class="hero-body">${escapeHtml(hero.body)}</p>
          <p class="release-note">${escapeHtml(hero.note)}</p>
          <div class="hero-actions">
            <a class="button button-primary" href="#install">Install the plugin</a>
            <a class="button button-secondary" href="#workflow">Explore the workflow</a>
          </div>
        </div>
        <figure class="handoff" aria-labelledby="handoff-caption">
          <div class="handoff-diagram">
            <ol class="handoff-lanes">
${lanes}
            </ol>
            <div class="handoff-bracket" aria-hidden="true"></div>
          </div>
          <p class="handoff-feedback">Feedback route: <strong>${escapeHtml(
            illustration.feedback,
          )}</strong>.</p>
          <figcaption id="handoff-caption" class="handoff-caption">${escapeHtml(
            illustration.caption,
          )}</figcaption>
        </figure>
      </section>`;
}

function renderSection(section, bodyHtml) {
  const paragraphs = (section.paragraphs ?? [])
    .map((text) => `          <p>${escapeHtml(text)}</p>`)
    .join("\n");
  const intro = paragraphs
    ? `
          <div class="section-intro">
${paragraphs}
          </div>`
    : "";
  return `      <section id="${escapeAttr(section.id)}" class="section" aria-labelledby="${escapeAttr(
    section.id,
  )}-heading">
        <h2 id="${escapeAttr(section.id)}-heading">${escapeHtml(section.heading)}</h2>${intro}
        <div class="section-body">
${bodyHtml}
        </div>
      </section>`;
}

function renderWarning(text, extraClass = "") {
  const cls = extraClass ? `warning ${extraClass}` : "warning";
  return `          <p class="${cls}" role="note">${escapeHtml(text)}</p>`;
}

function renderReferenceTable(content, headingId, heading, idHeader, descHeader, rows) {
  const body = rows
    .map(
      (row) =>
        `              <tr><th scope="row"><code>${escapeHtml(
          row.id,
        )}</code></th><td>${escapeHtml(row.description)}</td></tr>`,
    )
    .join("\n");
  return `          <h3 id="${escapeAttr(
    headingId,
  )}">${escapeHtml(heading)}</h3>
          <table class="data-table" aria-labelledby="${escapeAttr(headingId)}">
            <thead><tr><th scope="col">${escapeHtml(idHeader)}</th><th scope="col">${escapeHtml(
              descHeader,
            )}</th></tr></thead>
            <tbody>
${body}
            </tbody>
          </table>`;
}

function renderWorkflowBody(content) {
  return renderReferenceTable(
    content,
    "roles-heading",
    "Role reference",
    "Role",
    "Responsibility",
    content.roles,
  );
}

function renderPatternsBody(content) {
  const table = renderReferenceTable(
    content,
    "templates-heading",
    "Templates",
    "Template ID",
    "Guidance",
    content.patterns,
  );
  const snippets = renderSnippets(content, [
    "workflow-example",
    "workflow-craft",
    "workflow-orchestrate",
  ]);
  return `${table}
${snippets}`;
}

function renderInstallBody(content) {
  const w = content.warnings;
  return [
    renderWarning(w.pluginArray, "warning-critical"),
    renderSnippets(content, ["install-preview", "install-write"]),
    renderWarning(w.installerPin, "warning-critical"),
    renderSnippets(content, ["install-bunx", "launch-opencode"]),
    renderWarning(w.resetYes),
    `          <h3 id="install-config-heading">Preview against a file</h3>`,
    renderSnippets(content, ["install-config-print"]),
    renderWarning(w.preview),
    `          <h3 id="install-doctor-heading">Health check and removal</h3>`,
    renderSnippets(content, ["doctor"]),
    renderWarning(w.doctor),
    renderWarning(w.uninstallDataLoss, "warning-critical"),
    renderSnippets(content, ["uninstall"]),
    renderWarning(w.uninstall),
  ].join("\n");
}

function renderConfigureBody(content) {
  const snippets = renderSnippets(content, ["config-json"]);
  const source = content.links.commandTemplates;
  return `${snippets}
${renderWarning(content.warnings.runtimeModel, "warning-critical")}
${renderWarning(content.warnings.provider)}
          <p class="source-note"><a href="${escapeAttr(
            source.href,
          )}">${escapeHtml(source.label)}</a>.</p>`;
}

function renderCommandsBody(content) {
  const rows = content.commands
    .map(
      (cmd) =>
        `              <tr><th scope="row"><code>${escapeHtml(
          cmd.id,
        )}</code></th><td>${escapeHtml(cmd.description)}</td></tr>`,
    )
    .join("\n");
  return `          <table class="data-table" aria-labelledby="commands-heading">
            <thead><tr><th scope="col">Command</th><th scope="col">What it does</th></tr></thead>
            <tbody>
${rows}
            </tbody>
          </table>`;
}

const STATUS_LABEL = {
  released: "Released",
  "prompt-guided": "Not guaranteed",
  development: "Development",
};

function renderReleaseStatusBody(content) {
  const rows = content.releaseRows
    .map(
      (row) =>
        `              <tr class="status-${escapeAttr(row.status)}">
                <th scope="row"><span class="status-tag status-tag-${escapeAttr(
                  row.status,
                )}">${escapeHtml(STATUS_LABEL[row.status] ?? row.status)}</span></th>
                <td><strong>${escapeHtml(row.title)}</strong><br />${escapeHtml(row.text)}</td>
              </tr>`,
    )
    .join("\n");
  return `          <table class="data-table status-matrix" aria-labelledby="release-status-heading">
            <thead><tr><th scope="col">Status</th><th scope="col">What it means</th></tr></thead>
            <tbody>
${rows}
            </tbody>
          </table>
          <p class="source-note">The v0.3.0 engine work lives on the <a href="${escapeAttr(
            content.links.development.href,
          )}">${escapeHtml(
            content.links.development.label,
          )}</a>. It is informational only and is not an installation recommendation.</p>`;
}

function renderFaqBody(content) {
  return content.faq
    .map(
      (item) => `          <details class="faq-item">
            <summary>${escapeHtml(item.question)}</summary>
            <p>${escapeHtml(item.answer)}</p>
          </details>`,
    )
    .join("\n");
}

function renderFooter(content) {
  const links = ["npm", "repository", "issues", "license"]
    .map((key) => content.links[key])
    .map(
      (link) =>
        `          <li><a href="${escapeAttr(link.href)}">${escapeHtml(link.label)}</a></li>`,
    )
    .join("\n");
  return `    <footer class="site-footer">
      <p>opencode-teamwork — an independent community project. No affiliation with Google, Antigravity, OpenCode or a model provider is implied.</p>
      <ul class="footer-links">
${links}
      </ul>
      <p class="footer-meta">Release documented: ${escapeHtml(
        content.documentedRelease,
      )}. This static page makes no network requests and installs nothing.</p>
    </footer>`;
}

export function readTemplate() {
  return readFileSync(new URL("./page.html", import.meta.url), "utf-8");
}

export function renderPage(content, template = readTemplate()) {
  if (typeof template !== "string" || template.length === 0) {
    throw new Error("renderPage: template must be a non-empty string");
  }

  assertUniqueIds(content.snippets, "snippets");
  assertUniqueIds(content.sections, "sections");

  const sectionById = (id) => navSection(content, id);

  const replacements = {
    skip: renderSkip(),
    header: renderHeader(content),
    hero: renderHero(content),
    workflow: renderSection(sectionById("workflow"), renderWorkflowBody(content)),
    patterns: renderSection(sectionById("patterns"), renderPatternsBody(content)),
    install: renderSection(sectionById("install"), renderInstallBody(content)),
    configure: renderSection(sectionById("configure"), renderConfigureBody(content)),
    commands: renderSection(sectionById("commands"), renderCommandsBody(content)),
    "release-status": renderSection(
      sectionById("release-status"),
      renderReleaseStatusBody(content),
    ),
    faq: renderSection(sectionById("faq"), renderFaqBody(content)),
    footer: renderFooter(content),
  };

  const markerPattern = () => /<!--\s*@([a-z0-9-]+)\s*-->/gi;
  const seen = new Set();
  const matches = template.match(markerPattern()) ?? [];
  if (matches.length === 0) {
    throw new Error("renderPage: template contains no insertion markers");
  }
  for (const raw of matches) {
    const name = raw.replace(markerPattern(), "$1").toLowerCase();
    if (seen.has(name)) {
      throw new Error(`renderPage: duplicate marker "${name}"`);
    }
    seen.add(name);
    if (!(name in replacements)) {
      throw new Error(`renderPage: unknown marker "${name}"`);
    }
  }
  for (const key of Object.keys(replacements)) {
    if (!seen.has(key)) {
      throw new Error(`renderPage: marker "${key}" is missing from the template`);
    }
  }

  const html = template.replace(markerPattern(), (_, name) => replacements[String(name).toLowerCase()]);
  if (markerPattern().test(html)) {
    throw new Error("renderPage: unfilled marker remains in output");
  }
  return html;
}
