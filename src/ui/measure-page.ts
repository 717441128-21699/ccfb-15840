/**
 * 测弦页:对选定键录音 → 分音匹配 → 非谐系数 B 拟合 → 入档
 */

import { AnalysisFrame } from '../audio/engine';
import { session } from '../audio/session';
import { midiToFreq, midiToName } from '../math/acoustics';
import { partialFrequency } from '../math/inharmonic';
import { measureString, type MeasureResult } from '../math/analyzer';
import { store } from '../state/store';
import { clear, el, fmt, fmtHz, fmtSci, toast } from './dom';
import { drawSpectrum } from './canvas-plot';
import { miniKeyboard } from './keyboard';
import { Page } from './router';
import { Measurement } from '../types';

export class MeasurePage implements Page {
  private host: HTMLElement;
  private selected = 49; // A3
  private collecting = false;
  private frames: AnalysisFrame[] = [];
  private lastFrame: AnalysisFrame | null = null;
  private result: MeasureResult | null = null;
  private unsub: (() => void) | null = null;
  private rafId = 0;
  private canvas!: HTMLCanvasElement;
  private metricHost!: HTMLElement;
  private tableHost!: HTMLElement;
  private collectBtn!: HTMLButtonElement;
  private statusPill!: HTMLElement;
  private latencyPill!: HTMLElement;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  mount(): void {
    const piano = store.currentPiano();
    if (!piano) {
      this.renderEmpty();
      return;
    }
    this.render();
    this.unsub = session.onFrame((f) => this.handleFrame(f));
    this.loopDraw();
  }

  unmount(): void {
    this.unsub?.();
    cancelAnimationFrame(this.rafId);
    if (this.collecting) void this.stopCollect(false);
  }

  private renderEmpty(): void {
    clear(this.host);
    this.host.append(
      el(
        'div',
        { class: 'empty' },
        el('span', { class: 'big', text: '🗂' }),
        el('p', { text: '请先在「琴档案」页选择一台钢琴,再开始测弦。' }),
      ),
    );
  }

  private render(): void {
    clear(this.host);
    const piano = store.currentPiano()!;
    const spec = piano.strings.find((s) => s.midi === this.selected)!;

    const page = el('div', { class: 'page' });

    page.append(
      el(
        'h2',
        { class: 'page-title' },
        '测弦 · 非谐系数拟合',
        el(
          'span',
          { class: 'hint', text: '录下单键声音,定位前 16 个泛音并拟合 B' },
        ),
      ),
    );

    // 键盘
    page.append(
      miniKeyboard({
        selected: this.selected,
        measured: new Set(store.currentMeasurements().map((m) => m.midi)),
        tuned: new Map(),
        onSelect: (midi) => {
          this.selected = midi;
          this.result = null;
          this.frames = [];
          this.refreshDemo();
          this.render();
        },
      }),
    );

    // 控制行
    this.collectBtn = el('button', {
      class: 'primary',
      text: '● 开始测弦',
    });
    this.collectBtn.addEventListener('click', () => {
      if (this.collecting) void this.stopCollect(true);
      else void this.startCollect();
    });

    this.statusPill = el('span', { class: 'pill', text: '待机' });
    this.latencyPill = el('span', { class: 'pill', text: '延迟 —' });

    const saveBtn = el('button', { text: '存入档案' });
    saveBtn.addEventListener('click', () => this.saveResult());

    const controls = el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'row spread' },
        el(
          'div',
          { class: 'row' },
          el('div', { class: 'note-big', text: midiToName(this.selected) }),
          el(
            'div',
            {},
            el('div', { class: 'target-line', text: `平均律 ${fmtHz(spec.fEqual)}` }),
            el(
              'div',
              { class: 'target-line', text: `理论 B = ${fmtSci(spec.bTheory)} · 弦长 ${(spec.length * 100).toFixed(1)} cm · 线径 ${(spec.diameter * 1000).toFixed(2)} mm` },
            ),
          ),
        ),
        el('div', { class: 'row' }, this.statusPill, this.latencyPill),
      ),
      el('div', { class: 'row', style: 'margin-top:12px' }, this.collectBtn, saveBtn),
    );
    page.append(controls);

    // 指标
    this.metricHost = el('div', { class: 'grid4' });
    page.append(this.metricHost);
    this.renderMetrics();

    // 频谱
    const specCard = el('div', { class: 'card' });
    specCard.append(
      el('h3', { text: '频谱与分音匹配' }),
      (this.canvas = el('canvas', { height: '260' })),
      el(
        'div',
        { class: 'legend', style: 'margin-top:8px' },
        el('span', {}, el('i', { style: 'background:#4dd0e1' }), '幅值谱'),
        el('span', {}, el('i', { style: 'background:#b39ddb' }), '模型预测分音'),
        el('span', {}, el('i', { style: 'background:#66bb6a;border-radius:50%' }), '已匹配峰'),
        el('span', {}, el('i', { style: 'background:#ffa726' }), '局部峰'),
      ),
    );
    page.append(specCard);

    // 分音表
    const tableCard = el('div', { class: 'card' });
    tableCard.append(el('h3', { text: '分音明细' }));
    this.tableHost = el('div', { class: 'table-wrap' });
    tableCard.append(this.tableHost);
    page.append(tableCard);

    this.host.append(page);

    if (session.started) void this.refreshDemo();
  }

  private async startCollect(): Promise<void> {
    if (!session.started) {
      try {
        await session.start(this.demoOpts());
      } catch (e) {
        toast(`音频启动失败:${(e as Error).message}`);
        return;
      }
    } else {
      await this.refreshDemo();
    }
    this.collecting = true;
    this.frames = [];
    this.result = null;
    this.collectBtn.textContent = '■ 停止并拟合';
    this.statusPill.textContent = '采集中…';
    this.statusPill.className = 'pill warn';
    // 采集约 1.2 秒后自动拟合(覆盖多个分析帧)
    window.setTimeout(() => {
      if (this.collecting) void this.stopCollect(true);
    }, 1400);
  }

  private async stopCollect(fit: boolean): Promise<void> {
    this.collecting = false;
    this.collectBtn.textContent = '● 开始测弦';
    if (fit && this.frames.length > 0) {
      try {
        const approx = midiToFreq(this.selected);
        const roughB =
          store.currentPiano()?.strings.find((s) => s.midi === this.selected)
            ?.bTheory ?? 8e-5;
        this.result = measureString(this.frames, approx, { roughB });
        this.statusPill.textContent = `拟合完成 R²=${fmt(this.result.r2, 4)}`;
        this.statusPill.className = 'pill good';
        this.renderMetrics();
        this.renderTable();
      } catch (e) {
        this.statusPill.textContent = '拟合失败';
        this.statusPill.className = 'pill bad';
        toast((e as Error).message);
      }
    } else {
      this.statusPill.textContent = '待机';
      this.statusPill.className = 'pill';
    }
  }

  private handleFrame(f: AnalysisFrame): void {
    this.lastFrame = f;
    this.latencyPill.textContent = `端到端 ${f.receivedAt ? Math.round(session.latencyMs) : '—'} ms`;
    if (this.collecting) this.frames.push(f);
  }

  private loopDraw = (): void => {
    if (this.canvas && this.lastFrame) {
      const approx = this.result?.f1 ?? midiToFreq(this.selected);
      const b = this.result?.b ??
        store.currentPiano()?.strings.find((s) => s.midi === this.selected)
          ?.bTheory ?? 8e-5;
      const expected: number[] = [];
      for (let n = 1; n <= 16; n++) {
        const f = partialFrequency(approx, b, n);
        if (f > 5000) break;
        expected.push(f);
      }
      drawSpectrum(this.canvas, {
        magnitude: this.lastFrame.magnitude,
        binHz: this.lastFrame.binHz,
        fftSize: this.lastFrame.fftSize,
        peaks: this.lastFrame.peaks,
        expectedPartials: expected,
        matchedFrequencies: this.result?.partialFrequencies,
        maxFreq: 5000,
      });
    }
    this.rafId = requestAnimationFrame(this.loopDraw);
  };

  private renderMetrics(): void {
    if (!this.metricHost) return;
    const spec = store.currentPiano()!.strings.find(
      (s) => s.midi === this.selected,
    )!;
    const r = this.result;
    const diffPct = r ? ((r.b - spec.bTheory) / spec.bTheory) * 100 : null;
    const diffPill =
      diffPct === null
        ? null
        : el(
            'span',
            {
              class: `pill ${Math.abs(diffPct) <= 10 ? 'good' : 'warn'}`,
              text: `与理论值差 ${fmt(diffPct, 1)}%`,
            },
          );

    this.metricHost.replaceChildren(
      this.metric('拟合基频 f₁', r ? fmtHz(r.f1) : '—', `平均律 ${fmtHz(spec.fEqual)}`),
      this.metric('非谐系数 B', r ? fmtSci(r.b) : '—', `理论 ${fmtSci(spec.bTheory)}`),
      this.metric(
        'B 偏差',
        diffPct === null ? '—' : `${fmt(diffPct, 1)} %`,
        '验收阈值 ±10%',
      ),
      this.metric(
        '拟合分音 / R²',
        r ? `${r.partialsUsed} 个` : '—',
        r ? `R² = ${fmt(r.r2, 4)}` : '等待测量',
      ),
    );
    if (diffPill) this.metricHost.append(diffPill);
  }

  private renderTable(): void {
    if (!this.tableHost || !this.result) return;
    const r = this.result;
    const rows = r.partialFrequencies.map((f, i) => {
      const n = i + 1;
      const ideal = n * r.f1;
      const stretchCents = 1200 * Math.log2(f / ideal);
      return el(
        'tr',
        { class: 'measured' },
        el('td', { text: `第 ${n} 分音` }),
        el('td', { text: fmtHz(f) }),
        el('td', { text: fmtHz(ideal) }),
        el('td', { text: `+${fmt(stretchCents, 2)} ¢` }),
        el(
          'td',
          {
            class: r.missingPartials.includes(n) ? 'pill bad' : '',
            text: r.missingPartials.includes(n) ? '缺失(插值)' : '实测',
          },
        ),
      );
    });
    this.tableHost.replaceChildren(
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', { text: '分音' }),
            el('th', { text: '实测频率' }),
            el('th', { text: '理想整数倍 n·f₁' }),
            el('th', { text: '刚度上偏量' }),
            el('th', { text: '状态' }),
          ),
        ),
        el('tbody', {}, ...rows),
      ),
    );
  }

  private metric(k: string, v: string, sub: string): HTMLElement {
    return el(
      'div',
      { class: 'metric' },
      el('div', { class: 'k', text: k }),
      el('div', { class: 'v', text: v }),
      el('div', { class: 'sub', text: sub }),
    );
  }

  private demoOpts() {
    const spec = store.currentPiano()!.strings.find(
      (s) => s.midi === this.selected,
    )!;
    return {
      f1: spec.fEqual,
      b: spec.bTheory,
      unisons: spec.unisons,
      duration: 2.5,
      seed: spec.midi * 997 + 13,
    };
  }

  private async refreshDemo(): Promise<void> {
    if (store.settings.demoMode && session.started) {
      await session.switchDemo(this.demoOpts());
    }
  }

  private saveResult(): void {
    if (!this.result) {
      toast('请先完成一次测弦');
      return;
    }
    const m: Measurement = {
      midi: this.selected,
      f1: this.result.f1,
      b: this.result.b,
      partialsUsed: this.result.partialsUsed,
      r2: this.result.r2,
      partialFrequencies: this.result.partialFrequencies,
      measuredAt: Date.now(),
    };
    store.addMeasurement(m);
    toast(`已保存 ${midiToName(this.selected)} 的 B = ${fmtSci(m.b)}`);
    this.render();
  }
}
