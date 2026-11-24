/** 轻量 DOM 辅助 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | undefined> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (k.startsWith('data-')) node.setAttribute(k, String(v));
    else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

let toastTimer: number | undefined;
export function toast(message: string, ms = 2200): void {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = el('div', { class: 'toast', text: message });
  document.body.append(t);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.remove(), ms);
}

export function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

/** 科学计数法紧凑显示,如 8.42e-5 */
export function fmtSci(n: number, digits = 3): string {
  if (!Number.isFinite(n) || n === 0) return '—';
  return n
    .toExponential(digits)
    .replace('e+', 'e')
    .replace('e0', 'e');
}

export function fmtHz(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(3)} kHz`;
  return `${n.toFixed(2)} Hz`;
}

/** 音分带符号显示 */
export function fmtCents(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)} ¢`;
}
