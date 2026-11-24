/**
 * 88 键迷你键盘(MIDI 21..108)
 * 标记实测键、已调键、当前选中键
 */

import { el } from './dom';

const BLACK_SET = new Set([1, 3, 6, 8, 10]);

export interface KeyboardOptions {
  selected: number;
  measured: Set<number>;
  tuned: Map<number, number>;
  onSelect: (midi: number) => void;
}

export function miniKeyboard(opts: KeyboardOptions): HTMLElement {
  const wrap = el('div', { class: 'mini-keyboard' });
  for (let midi = 21; midi <= 108; midi++) {
    const isBlack = BLACK_SET.has(midi % 12);
    const classes = ['mk'];
    if (isBlack) classes.push('black');
    if (opts.measured.has(midi)) classes.push('measured');
    if (opts.tuned.has(midi)) classes.push('done');
    if (midi === opts.selected) classes.push('selected');
    const key = el('button', {
      class: classes.join(' '),
      title: `MIDI ${midi}`,
    });
    key.addEventListener('click', () => opts.onSelect(midi));
    wrap.append(key);
  }
  return wrap;
}
