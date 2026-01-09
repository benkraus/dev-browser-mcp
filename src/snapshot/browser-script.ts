let cachedScript: string | null = null;

export function getSnapshotScript(): string {
  if (cachedScript) return cachedScript;

  cachedScript = `
(function() {
  if (window.__devBrowser_getAISnapshot) return;

  let __devBrowserLastRef = window.__devBrowserLastRef || 0;

  function normalizeText(s) {
    return String(s || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    const style = window.getComputedStyle(el);
    if (!style) return true;
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getRole(el) {
    const explicit = normalizeText(el.getAttribute("role"));
    if (explicit) return explicit;
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "A") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "BUTTON") return "button";
    if (tag === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button" || t === "reset") return "button";
      return "textbox";
    }
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "SELECT") return "combobox";
    if (tag === "OPTION") return "option";
    if (tag === "H1" || tag === "H2" || tag === "H3" || tag === "H4" || tag === "H5" || tag === "H6") return "heading";
    if (tag === "IMG") return "img";
    return "generic";
  }

  function getName(el) {
    const ariaLabel = normalizeText(el.getAttribute("aria-label"));
    if (ariaLabel) return ariaLabel;

    const alt = normalizeText(el.getAttribute("alt"));
    if (alt) return alt;

    const placeholder = normalizeText(el.getAttribute("placeholder"));
    if (placeholder) return placeholder;

    if (el.tagName && el.tagName.toUpperCase() === "INPUT") {
      const value = normalizeText(el.value);
      if (value) return value;
    }

    const text = normalizeText(el.innerText || el.textContent);
    if (text) return text;

    return "";
  }

  function isInteractiveRole(role) {
    return ["button", "link", "textbox", "checkbox", "radio", "combobox", "option"].includes(role);
  }

  function shouldInclude(el, role, name) {
    if (!isVisible(el)) return false;
    if (isInteractiveRole(role)) return true;
    if (role === "heading" && name) return true;
    return false;
  }

  function snapshot() {
    const refs = {};
    const lines = [];

    function visit(el, depth) {
      if (!el || el.nodeType !== 1) return;
      const role = getRole(el);
      const name = getName(el);

      if (shouldInclude(el, role, name)) {
        const ref = "e" + (++__devBrowserLastRef);
        refs[ref] = el;
        const indent = "  ".repeat(depth);
        const displayName = name ? JSON.stringify(name) : "\"\"";
        lines.push(indent + "- " + role + " " + displayName + " [ref=" + ref + "]");
      }

      const children = el.children || [];
      for (let i = 0; i < children.length; i++) {
        visit(children[i], Math.min(depth + 1, 6));
      }
    }

    visit(document.body, 0);

    window.__devBrowserRefs = refs;
    window.__devBrowserLastRef = __devBrowserLastRef;

    return lines.join("\n");
  }

  function selectSnapshotRef(ref) {
    const refs = window.__devBrowserRefs;
    if (!refs) throw new Error("No snapshot refs found. Call getAISnapshot first.");
    const el = refs[ref];
    if (!el) throw new Error("Ref not found: " + ref);
    return el;
  }

  window.__devBrowser_getAISnapshot = snapshot;
  window.__devBrowser_selectSnapshotRef = selectSnapshotRef;
})();
`;

  return cachedScript;
}

export function clearSnapshotScriptCache(): void {
  cachedScript = null;
}
