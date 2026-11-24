/**
 * 逐键调律页
 * 实时多泛音融合测频 → 相对拉伸目标的音分偏差大圆表;
 * 频谱聚类分辨同音弦拍频;显示与相邻参考键的八度/十二度拍频。
 */

import { AnalysisFrame } from '../audio/engine';
import { session } from '../audio/session';
import { midiToFreq, midiToName, ratioToCents } from '../math/acoustics';
import { LiveTuner, analyzeUnisons } from '../math/analyzer';
import { BeatResult, TunerReading } from '../types';
import { beatRateHz } from '../math/tuning';
import { store } from '../state/store';
import { clear, el, fmt, fmtHz, fmtSci, toast } from './dom';
import { drawSpectrum } from './canvas-plot';
import { miniKeyboard } from './keyboard';
import { Page } from './router';

const DIAL_RANGE = 50; // 音分表满量程 ±50¢

export class TunePage implements Page {
  private host: HTMLElement;
  private selected = 69;
  private tuner: LiveTuner | null = null;
  private unsub: (() => void) | null = null;
  private rafId = 0;
  private latestReading: TunerReading | null = null;
  private latestBeat: BeatResult | null = null;
  private latestFrame: AnalysisFrame | null = null;

  private dialCanvas!: HTMLCanvasElement;
  private spectrumCanvas!: HTMLCanvasElement;
  private centsEl!: HTMLElement;
  private noteEl!: HTMLElement;
  private targetEl!: HTMLElement;
  private beatHost!: HTMLElement;
  private intervalHost!: HTMLElement;
  private latencyPill!: HTMLElement;
  private startBtn!: HTMLButtonElement;
  private running = false;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  mount(): void {
    if (!store.currentPiano()) {
      clear(this.host);
      this.host.append(
        el(
          'div',
          { class: 'empty' },
          el('span', { class: 'big', text: '🎯' }),
          el('p', { text: '请先在「琴档案」页选择一台钢琴。' }),
        ),
      );
      return;
    }
    this.render();
    this.unsub = session.onFrame((f) => this.handleFrame(f));
    this.loop();
  }

  unmount(): void {
    this.unsub?.();
    cancelAnimationFrame(this.rafId);
  }

  private targetFor(midi: number) {
    return store.targetFor(midi)!;
  }

  private render(): void {
    clear(this.host);
    const piano = store.currentPiano()!;
    const spec = piano.strings.find((s) => s.midi === this.selected)!;
    const target = this.targetFor(this.selected);
    const b = store.bFor(this.selected)!;

    const page = el('div', { class: 'page' });
    page.append(
      el(
        'h2',
        { class: 'page-title' },
        '逐键调律',
        el(
          'span',
          {
            class: 'hint',
            text: '目标已按本琴非谐性拉伸;针盘进入 ±2¢ 绿区即拍频最小',
          },
        ),
      ),
    );

    page.append(
      miniKeyboard({
        selected: this.selected,
        measured: new Set(store.currentMeasurements().map((m) => m.midi)),
        tuned: store.tuningProgress.get(piano.id) ?? new Map(),
        onSelect: (midi) => this.selectKey(midi),
      }),
    );

    // 控制行
    this.startBtn = el('button', {
      class: 'primary',
      text: session.started ? '■ 停止监听' : '▶ 开始监听',
    });
    this.startBtn.addEventListener('click', () => {
      if (this.running) void this.stop();
      else void this.start();
    });
    this.latencyPill = el('span', { class: 'pill', text: '延迟 —(要求 ≤150 ms)' });
    const prev = el('button', { class: 'nav', text: '‹' });
    prev.addEventListener('click', () => this.selectKey(this.selected - 1));
    const next = el('button', { class: 'nav', text: '›' });
    next.addEventListener('click', () => this.selectKey(this.selected + 1));
    const markBtn = el('button', { text: '标记本键完成' });
    markBtn.addEventListener('click', () => {
      if (this.latestReading) {
        store.recordTuningProgress(this.selected, this.latestReading.centsError);
        toast(`${midiToName(this.selected)} 已记录`);
      } else {
        toast('尚无稳定读数');
      }
    });

    page.append(
      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'row spread' },
          el('div', { class: 'keynav' }, prev, next, markBtn),
          el('div', { class: 'row' }, this.latencyPill, this.startBtn),
        ),
      ),
    );

    // 主区:针盘 + 拍频
    const hero = el('div', { class: 'card tuner-hero' });
    const dialWrap = el('div', { class: 'dial-wrap' });
    this.noteEl = el('div', { class: 'note-big', text: midiToName(this.selected) });
    this.centsEl = el('div', { class: 'cents-big', text: '— ¢' });
    this.targetEl = el(
      'div',
      {
        class: 'target-line',
        text: `目标 ${fmtHz(target.frequency)} · 平均律 ${fmtHz(spec.fEqual)} · 拉伸 ${target.centsOffset >= 0 ? '+' : ''}${fmt(target.centsOffset, 1)}¢ · B=${fmtSci(b)}`,
      },
    );
    this.dialCanvas = el('canvas', { height: '210' });
    dialWrap.append(this.noteEl, this.dialCanvas, this.centsEl, this.targetEl);

    this.beatHost = el('div', { class: 'beat-box' });
    this.intervalHost = el('div', { class: 'beat-box' });
    const beatCard = el(
      'div',
      {},
      el('h3', { text: '同音弦拍频(三弦不齐)' }),
      this.beatHost,
      el('h3', { style: 'margin-top:14px', text: '参考音程拍频(当前实测)' }),
      this.intervalHost,
    );
    hero.append(dialWrap, beatCard);
    page.append(hero);

    // 频谱
    const specCard = el('div', { class: 'card' });
    specCard.append(el('h3', { text: '实时频谱' }));
    this.spectrumCanvas = el('canvas', { height: '200' });
    specCard.append(this.spectrumCanvas);
    page.append(specCard);

    this.host.append(page);
    this.renderBeat(null);
    this.renderIntervals(null);
    this.drawDial(null);

    // 重建调谐器
    this.tuner = new LiveTuner({
      midi: this.selected,
      targetFrequency: target.frequency,
      b,
    });
  }

  private selectKey(midi: number): void {
    if (midi < 21 || midi > 108) return;
    this.selected = midi;
    this.latestReading = null;
    this.latestBeat = null;
    this.render();
    if (this.running) {
      const target = this.targetFor(midi);
      this.tuner = new LiveTuner({
        midi,
        targetFrequency: target.frequency,
        b: store.bFor(midi)!,
      });
      void this.refreshDemo();
    }
  }

  private demoOpts() {
    const spec = store
      .currentPiano()!
      .strings.find((s) => s.midi === this.selected)!;
    // 演示:故意让三弦有轻微失调,产生可听拍频
    const detune =
      spec.unisons > 1
        ? Array.from({ length: spec.unisons }, (_, i) =>
            (i - (spec.unisons - 1) / 2) * 1.6,
          )
        : [0];
    return {
      f1: spec.fEqual,
      b: spec.bTheory,
      unisons: spec.unisons,
      unisonDetuneCents: detune,
      duration: 3,
      seed: spec.midi * 131 + 7,
    };
  }

  private async start(): Promise<void> {
    try {
      if (!session.started) await session.start(this.demoOpts());
      else if (store.settings.demoMode) await this.refreshDemo();
      this.running = true;
      this.startBtn.textContent = '■ 停止监听';
      const target = this.targetFor(this.selected);
      this.tuner = new LiveTuner({
        midi: this.selected,
        targetFrequency: target.frequency,
        b: store.bFor(this.selected)!,
      });
    } catch (e) {
      toast(`音频启动失败:${(e as Error).message}`);
    }
  }

  private async stop(): Promise<void> {
    this.running = false;
    this.startBtn.textContent = '▶ 开始监听';
    await session.stop();
  }

  private async refreshDemo(): Promise<void> {
    if (store.settings.demoMode) await session.switchDemo(this.demoOpts());
  }

  private handleFrame(f: AnalysisFrame): void {
    this.latestFrame = f;
    this.latencyPill.textContent = `端到端 ${Math.round(session.latencyMs)} ms(要求 ≤150)`;
    this.latencyPill.className =
      session.latencyMs <= 150 ? 'pill good' : 'pill bad';
    if (!this.running || !this.tuner) return;

    const reading = this.tuner.process(f);
    if (reading) {
      this.latestReading = reading;
      this.latestBeat = analyzeUnisons(
        f,
        reading.fundamental,
        store.bFor(this.selected)!,
        this.targetFor(this.selected).frequency,
      );
      // 调律进度持续记录(仅在置信度足够时)
      if (reading.confidence > 0.5) {
        store.recordTuningProgress(this.selected, reading.centsError);
      }
    }
  }

  private loop = (): void => {
    if (this.running && this.latestReading) {
      const r = this.latestReading;
      this.centsEl.textContent = `${r.centsError >= 0 ? '+' : ''}${fmt(r.centsError, 1)} ¢`;
      this.centsEl.className =
        'cents-big ' +
        (Math.abs(r.centsError) <= 2
          ? 'in-tune'
          : Math.abs(r.centsError) <= 10
            ? 'shop'
            : 'far');
      this.drawDial(r.centsError);
      this.renderBeat(this.latestBeat);
      this.renderIntervals(r);
    } else {
      this.drawDial(null);
    }
    if (this.spectrumCanvas && this.latestFrame) {
      drawSpectrum(this.spectrumCanvas, {
        magnitude: this.latestFrame.magnitude,
        binHz: this.latestFrame.binHz,
        fftSize: this.latestFrame.fftSize,
        peaks: this.latestFrame.peaks,
        maxFreq: 4000,
      });
    }
    this.rafId = requestAnimationFrame(this.loop);
  };

  private drawDial(cents: number | null): void {
    const canvas = this.dialCanvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h - 14;
    const radius = Math.min(w / 2 - 24, h - 30);
    const angleOf = (c: number) =>
      Math.PI + ((c + DIAL_RANGE) / (2 * DIAL_RANGE)) * Math.PI;

    // 弧段背景:红→黄→绿→黄→红
    const segments = [
      { range: [-50, -10], color: 'rgba(239,83,80,0.55)' },
      { range: [-10, -2], color: 'rgba(255,167,38,0.6)' },
      { range: [-2, 2], color: 'rgba(102,187,106,0.85)' },
      { range: [2, 10], color: 'rgba(255,167,38,0.6)' },
      { range: [10, 50], color: 'rgba(239,83,80,0.55)' },
    ];
    ctx.lineWidth = 14;
    ctx.lineCap = 'butt';
    for (const seg of segments) {
      ctx.strokeStyle = seg.color;
      ctx.beginPath();
      ctx.arc(
        cx,
        cy,
        radius,
        angleOf(seg.range[0]),
        angleOf(seg.range[1]),
      );
      ctx.stroke();
    }

    // 刻度
    ctx.strokeStyle = '#93a1bb';
    ctx.fillStyle = '#93a1bb';
    ctx.font = '10px system-ui';
    ctx.lineWidth = 1.5;
    for (let c = -50; c <= 50; c += 10) {
      const a = angleOf(c);
      const x1 = cx + Math.cos(a) * (radius - 12);
      const y1 = cy + Math.sin(a) * (radius - 12);
      const x2 = cx + Math.cos(a) * (radius + 2);
      const y2 = cy + Math.sin(a) * (radius + 2);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      const tx = cx + Math.cos(a) * (radius + 16);
      const ty = cy + Math.sin(a) * (radius + 16);
      ctx.textAlign = 'center';
      ctx.fillText(`${c}`, tx, ty + 3);
    }

    // 指针
    const value = cents === null ? 0 : Math.max(-DIAL_RANGE, Math.min(DIAL_RANGE, cents));
    const a = angleOf(value);
    ctx.strokeStyle = cents === null ? '#54627c' : '#e8edf7';
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * (radius - 20), cy + Math.sin(a) * (radius - 20));
    ctx.stroke();
    ctx.fillStyle = '#4dd0e1';
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = 'start';
  }

  private renderBeat(beat: BeatResult | null): void {
    if (!beat || beat.stringFrequencies.length <= 1) {
      this.beatHost.replaceChildren(
        el(
          'div',
          { class: 'beat-item' },
          el('span', { text: '未检出多弦拍(单弦或已调齐)' }),
          el('span', { class: 'rate', style: 'color:var(--good)', text: '0.0 Hz' }),
        ),
      );
      return;
    }
    const items = beat.beatRates.map((rate, i) =>
      el(
        'div',
        { class: 'beat-item' },
        el(
          'span',
          {
            text: `弦 ${i + 1}↔${i + 2} · 偏差 ${fmt(
              beat.stringCentsErrors[i + 1] - beat.stringCentsErrors[i],
              1,
            )}¢`,
          },
        ),
        el(
          'span',
          {
            class: 'rate',
            style: rate < 0.5 ? 'color:var(--good)' : 'color:var(--warn)',
            text: `${fmt(rate, 2)} Hz`,
          },
        ),
      ),
    );
    this.beatHost.replaceChildren(...items);
  }

  private renderIntervals(reading: TunerReading | null): void {
    const piano = store.currentPiano()!;
    const bTable = store.bTable()!;
    const midi0 = piano.strings[0].midi;
    const bAt = (midi: number) => bTable.values[midi - midi0];
    const targetAt = (midi: number) => store.targetFor(midi)!;

    const intervals = [
      { span: 12, p: 2, q: 1, label: '八度 2:1' },
      { span: 19, p: 3, q: 1, label: '十二度 3:1' },
    ];

    const rows: HTMLElement[] = [];
    for (const iv of intervals) {
      const hi = this.selected + iv.span;
      if (hi > 108) continue;
      const fLo = reading?.fundamental ?? targetAt(this.selected).frequency;
      const fHi = targetAt(hi).frequency;
      const rate = beatRateHz(fLo, bAt(this.selected), iv.p, fHi, bAt(hi), iv.q);
      rows.push(
        el(
          'div',
          { class: 'beat-item' },
          el('span', { text: `${iv.label} → ${midiToName(hi)}` }),
          el(
            'span',
            {
              class: 'rate',
              style: rate < 1 ? 'color:var(--good)' : 'color:var(--warn)',
              text: `${fmt(rate, 2)} Hz`,
            },
          ),
        ),
      );
    }
    if (rows.length === 0) {
      rows.push(
        el(
          'div',
          { class: 'beat-item' },
          el('span', { text: '高音区无可用参考音程' }),
        ),
      );
    }
    this.intervalHost.replaceChildren(...rows);
  }
}
