// Browser-only copy enhancement. This module has no top-level DOM access, so
// it imports cleanly in Node for tests. Copy buttons ship hidden in the static
// HTML and are revealed only once enhanceCopy has successfully bound them.
//
// Behavior contract:
// - never copy on load; only on an explicit activation
// - await the clipboard write before announcing success
// - read text from the target code element's textContent only
// - catch missing/denied/insecure clipboard APIs and say how to copy manually
// - keep feedback local to each block and ignore stale, out-of-order writes
// - leave a control hidden (never throw) when its target is missing

const boundTokens = new WeakMap();

function findFeedback(button) {
  const block = button.closest(".snippet") ?? button.parentElement;
  return block ? block.querySelector(".copy-feedback") : null;
}

function resolveTarget(root, targetId) {
  // Strictly scoped: the target must be exactly one <code> element inside the
  // provided root. No ownerDocument/global fallback, and duplicate or non-code
  // matches are refused so the control stays hidden rather than copying the
  // wrong text.
  if (!root || typeof root.querySelectorAll !== "function") return null;
  const escaped = targetId.replace(/([^\w-])/g, "\\$1");
  let matches;
  try {
    matches = root.querySelectorAll(`#${escaped}`);
  } catch {
    return null;
  }
  if (matches.length !== 1) return null;
  const element = matches[0];
  if (!element || element.tagName !== "CODE") return null;
  return element;
}

function handleActivation(button, target, writeText, feedback) {
  return async () => {
    const token = (boundTokens.get(button) ?? 0) + 1;
    boundTokens.set(button, token);
    if (feedback) feedback.textContent = "";

    const text = target.textContent ?? "";
    try {
      await writeText(text);
      if (boundTokens.get(button) !== token) return;
      if (feedback) feedback.textContent = "Copied";
    } catch {
      if (boundTokens.get(button) !== token) return;
      if (feedback) {
        feedback.textContent =
          "Copy unavailable. Select the command text and copy it manually.";
      }
    }
  };
}

/**
 * Bind copy buttons under root to writeText. Returns the number of controls
 * bound in this call. Safe to call more than once; each control binds once.
 */
export function enhanceCopy(root, writeText) {
  if (!root || typeof root.querySelectorAll !== "function") {
    throw new Error("enhanceCopy: a DOM root is required");
  }
  if (typeof writeText !== "function") {
    throw new Error("enhanceCopy: a writeText function is required");
  }

  const buttons = root.querySelectorAll(".copy-button");
  let bound = 0;
  for (const button of buttons) {
    if (button.dataset && button.dataset.copyBound === "true") continue;
    const targetId = button.getAttribute("data-copy-target");
    if (!targetId) continue;
    const target = resolveTarget(root, targetId);
    if (!target) continue;

    if (button.dataset) button.dataset.copyBound = "true";
    button.hidden = false;
    boundTokens.set(button, 0);
    const feedback = findFeedback(button);
    button.addEventListener("click", handleActivation(button, target, writeText, feedback));
    bound += 1;
  }
  return bound;
}

/** Production clipboard adapter: real API when present, honest rejection otherwise. */
export function clipboardAdapter(nav = typeof navigator !== "undefined" ? navigator : undefined) {
  if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
    return (text) => nav.clipboard.writeText(text);
  }
  return () => Promise.reject(new Error("Clipboard API unavailable"));
}

/** Initialize on a parsed document. No-op outside a browser. */
export function initCopy(doc = typeof document !== "undefined" ? document : null) {
  if (!doc) return 0;
  const start = () => enhanceCopy(doc, clipboardAdapter());
  if (doc.readyState === "loading") {
    doc.addEventListener("DOMContentLoaded", start, { once: true });
    return 0;
  }
  return start();
}

if (typeof document !== "undefined") {
  initCopy(document);
}
