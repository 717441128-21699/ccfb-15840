/**
 * 琴档案页:5 台预置琴选择、弦列参数浏览、测量档案、导入导出
 */

import { PianoProfile } from '../types';
import { store } from '../state/store';
import { clear, el, fmt, fmtSci, toast } from './dom';
import { midiToName } from '../math/acoustics';
import { Page } from './router';

export class ArchivePage implements Page {
  private host: HTMLElement;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  mount(): void {
    this.render();
  }

  unmount(): void {}

  private render(): void {
    clear(this.host);
    const page = el('div', { class: 'page' });
    page.append(
      el(
        'h2',
        { class: 'page-title' },
        '琴档案',
        el('span', { class: 'hint', text: '选择钢琴、浏览弦列物理参数与历史测量' }),
      ),
    );

    // 钢琴卡片
    const grid = el('div', { class: 'grid2' });
    for (const p of store.allPianos()) {
      grid.append(this.pianoCard(p));
    }
    page.append(grid);

    // 数据管理
    const dataCard = el('div', { class: 'card' });
    const exportBtn = el('button', { text: '导出全部数据 (JSON)' });
    exportBtn.addEventListener('click', () => this.exportData());
    const importBtn = el('button', { text: '导入 JSON 档案' });
    importBtn.addEventListener('click', () => this.importData());
    const fileInput = el('input', {
      type: 'file',
      accept: '.json,application/json',
      style: 'display:none',
    });
    fileInput.addEventListener('change', () =>
      this.handleFile(fileInput as HTMLInputElement),
    );
    const clearBtn = el('button', {
      class: 'danger',
      text: '清空本机存档',
    });
    clearBtn.addEventListener('click', () => {
      if (confirm('确定清空所有测量与进度?预置钢琴不受影响。')) {
        localStorage.removeItem('piano-tuner-state-v1');
        location.reload();
      }
    });
    dataCard.append(
      el('h3', { text: '数据管理' }),
      el('div', { class: 'row' }, exportBtn, importBtn, fileInput, clearBtn),
    );
    page.append(dataCard);

    // 当前琴弦列
    const current = store.currentPiano();
    if (current) {
      page.append(this.stringTableCard(current));
    }

    this.host.append(page);
  }

  private pianoCard(p: PianoProfile): HTMLElement {
    const selected = store.selectedPianoId === p.id;
    const nMeasured = (store.measurements.get(p.id) ?? []).length;
    const bass = p.strings[0];
    const treble = p.strings[p.strings.length - 1];
    const card = el('div', {
      class: `card`,
      style: selected ? 'border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)' : '',
    });
    const choose = el('button', {
      class: selected ? '' : 'primary',
      text: selected ? '✓ 当前使用' : '选择此琴',
    });
    choose.disabled = selected;
    choose.addEventListener('click', () => {
      store.selectPiano(p.id);
      toast(`已切换到 ${p.name}`);
      this.render();
    });

    card.append(
      el('div', { class: 'row spread' }, el('h3', { text: p.name }), choose),
      el('p', { style: 'color:var(--fg-dim);margin:6px 0 12px', text: p.kind }),
      el(
        'div',
        { class: 'grid3' },
        this.miniMetric('低音弦长', `${(bass.length * 100).toFixed(1)} cm`),
        this.miniMetric('高音弦长', `${(treble.length * 100).toFixed(2)} cm`),
        this.miniMetric('实测键数', `${nMeasured} / 88`),
        this.miniMetric('低音 B', fmtSci(bass.bTheory)),
        this.miniMetric('高音 B', fmtSci(treble.bTheory)),
        this.miniMetric(
          '张力范围',
          `${fmt(Math.min(...p.strings.map((s) => s.tension)), 0)}–${fmt(
            Math.max(...p.strings.map((s) => s.tension)),
            0,
          )} N`,
        ),
      ),
      el(
        'p',
        {
          style:
            'font-size:12.5px;color:var(--fg-dim);margin:12px 0 0;line-height:1.6',
          text: p.notes ?? '',
        },
      ),
    );
    return card;
  }

  private miniMetric(k: string, v: string): HTMLElement {
    return el(
      'div',
      { class: 'metric', style: 'padding:9px 11px' },
      el('div', { class: 'k', text: k }),
      el('div', { class: 'v', style: 'font-size:16px', text: v }),
    );
  }

  private stringTableCard(p: PianoProfile): HTMLElement {
    const card = el('div', { class: 'card' });
    card.append(
      el('h3', { text: `${p.name} · 88 键弦列参数(节选每 6 键)` }),
    );
    const wrap = el('div', { class: 'table-wrap' });
    const measuredMap = new Map(
      (store.measurements.get(p.id) ?? []).map((m) => [m.midi, m]),
    );
    const rows: HTMLElement[] = [];
    for (const s of p.strings) {
      if (s.midi % 6 !== 0 && s.midi !== 21 && s.midi !== 108) continue;
      const m = measuredMap.get(s.midi);
      rows.push(
        el(
          'tr',
          m ? { class: 'measured' } : {},
          el('td', { text: midiToName(s.midi) }),
          el('td', { text: String(s.midi) }),
          el('td', { text: s.wound ? '缠弦' : '裸弦' }),
          el('td', { text: `${s.unisons} 弦组` }),
          el('td', { text: `${(s.length * 100).toFixed(2)} cm` }),
          el('td', { text: `${(s.diameter * 1000).toFixed(3)} mm` }),
          el('td', {
            text: s.wound ? `${(s.windingDiameter * 1000).toFixed(3)} mm` : '—',
          }),
          el('td', { text: `${fmt(s.tension, 0)} N` }),
          el('td', { text: fmtSci(s.bTheory) }),
          el('td', { text: m ? fmtSci(m.b) : '—' }),
        ),
      );
    }
    wrap.append(
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', { text: '音名' }),
            el('th', { text: 'MIDI' }),
            el('th', { text: '类型' }),
            el('th', { text: '同音弦' }),
            el('th', { text: '弦长' }),
            el('th', { text: '芯径' }),
            el('th', { text: '铜绕组' }),
            el('th', { text: '张力' }),
            el('th', { text: '理论 B' }),
            el('th', { text: '实测 B' }),
          ),
        ),
        el('tbody', {}, ...rows),
      ),
    );
    card.append(wrap);
    return card;
  }

  private exportData(): void {
    const blob = new Blob([store.exportJSON()], {
      type: 'application/json',
    });
    const a = el('a', {
      href: URL.createObjectURL(blob),
      download: `piano-tuner-archive-${new Date().toISOString().slice(0, 10)}.json`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
    toast('档案已导出');
  }

  private importData(): void {
    const input = document.querySelector<HTMLInputElement>(
      '.card input[type=file]',
    );
    input?.click();
  }

  private handleFile(input: HTMLInputElement): void {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        store.importJSON(String(reader.result));
        toast('档案导入成功');
        this.render();
      } catch (e) {
        toast(`导入失败:${(e as Error).message}`);
      }
    };
    reader.readAsText(file);
    input.value = '';
  }
}
