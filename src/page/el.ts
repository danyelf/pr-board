// The only way the page makes elements. Text is always added as text nodes, so a title, ask, question or
// note that contains HTML is shown as those characters and never runs.

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href']);

function safeUrl(value: string): boolean {
  const v = value.trim();
  return v.startsWith('https:') || v.startsWith('/');
}

export function el(doc: Document, tag: string, attrs: Record<string, string> = {}, ...children: (Node | string | null)[]): HTMLElement {
  const node = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    const lower = name.toLowerCase();
    if (lower.startsWith('on')) throw new Error(`Refusing to set the event-handler attribute "${name}"`);
    if (URL_ATTRS.has(lower) && !safeUrl(value)) throw new Error(`Refusing ${name}="${value}": only https addresses and the board's own paths`);
    node.setAttribute(name, value);
  }
  for (const child of children) {
    if (child === null) continue;
    node.appendChild(typeof child === 'string' ? doc.createTextNode(child) : child);
  }
  return node;
}
