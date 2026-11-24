/**
 * 调律曲线页
 * - B 随音高变化(实测点 + 整琴拟合 + 理论值)
 * - 拉伸调律曲线(本琴求解 vs Railsback 公开曲线)
 * - 高音拉伸走势一致性指标
 */

import { railsbackCents } from '../data/pianos';
import { midiToName } from '../math/acoustics';
import { store } from '../state/store';
import { clear, el, fmt, fmtSci } from './dom';
import { drawTuningCurve } from './canvas-plot';
import { Page } from './router';

export class CurvePage implements Page {
  private host: HTMLElement;
  private curveCanvas!: HTMLCanvasElement;
  private bCanvas!: HTMLCanvasElement;
  private rafId = 0;

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
          el('span', { class: 'big', text: '📈' }),
          el('p', { text: '请先在「琴档案」页选择一台钢琴。' }),
        ),
      );
      return;
    }
    this.render();
  }

  unmount(): void {
    cancelAnimationFrame(this.rafId);
  }

  private render(): void {
    clear(this.host);
    const piano = store.currentPiano()!;
    const measurements = store.currentMeasurements();
    const bTable = store.bTable()!;
    const targets = store.tuningTargets();

    const page = el('div', { class: 'page' });
    page.append(
      el(
        'h2',
        { class: 'page-title' },
        '调律曲线',
        el(
          'span',
          {
            class: 'hint',
            text: `已实测 ${measurements.length} 个键 · 八度/十二度/双八度最小拍频求解`,
          },
        ),
      ),
    );

    // 高音拉伸一致性指标
    const trebleKeys = [84, 96, 108];
    const cmp = trebleKeys.map((midi) => {
      const t = targets.find((x) => x.midi === midi)!;
      return { midi, own: t.centsOffset, ref: railsbackCents(midi) };
    });
    const meanAbsErr =
      cmp.reduce((s, c) => s + Math.abs(c.own - c.ref), 0) / cmp.length;
    // 走势判定:高音单调上升、同为正拉伸,且 C8 端点与 Railsback 锚点吻合
    const c8Err = Math.abs(cmp[2].own - cmp[2].ref);
    const trendOk =
      cmp.every((c, i) => i === 0 || cmp[i - 1].own < c.own) &&
      cmp.every((c) => c.own > 0) &&
      c8Err < 8;

    const metricRow = el('div', { class: 'grid4' });
    metricRow.append(
      this.metric(
        'C6(84) 拉伸',
        `+${fmt(cmp[0].own, 2)} ¢`,
        `Railsback +${fmt(cmp[0].ref, 1)} ¢`,
      ),
      this.metric(
        'C7(96) 拉伸',
        `+${fmt(cmp[1].own, 2)} ¢`,
        `Railsback +${fmt(cmp[1].ref, 1)} ¢`,
      ),
      this.metric(
        'C8(108) 拉伸',
        `+${fmt(cmp[2].own, 2)} ¢`,
        `Railsback +${fmt(cmp[2].ref, 1)} ¢`,
      ),
      this.metric(
        '高音走势一致性',
        trendOk ? '通过' : '偏差偏大',
        `C8 端点偏差 ${fmt(c8Err, 2)} ¢(阈值 8¢)`,
      ),
    );
    page.append(metricRow);

    // 拉伸曲线
    const curveCard = el('div', { class: 'card' });
    curveCard.append(
      el('h3', { text: '整琴拉伸调律曲线(相对平均律,音分)' }),
      (this.curveCanvas = el('canvas', { height: '300' })),
      el(
        'div',
        { class: 'legend', style: 'margin-top:8px' },
        el('span', {}, el('i', { style: 'background:#4dd0e1' }), '本琴求解曲线'),
        el('span', {}, el('i', { style: 'background:#b39ddb' }), 'Railsback 公开统计曲线'),
        el('span', {}, el('i', { style: 'background:#66bb6a;border-radius:50%' }), '实测键'),
      ),
    );
    page.append(curveCard);

    // B 曲线
    const bCard = el('div', { class: 'card' });
    bCard.append(
      el('h3', { text: '非谐系数 B 随音高分布(对数轴)' }),
      (this.bCanvas = el('canvas', { height: '240' })),
    );
    page.append(bCard);

    // 实测 B 与理论 B 对照表
    const tableCard = el('div', { class: 'card' });
    tableCard.append(el('h3', { text: '实测键 B 值对照(验收:偏差 ≤ 10%)' }));
    const wrap = el('div', { class: 'table-wrap' });
    const rows = measurements.map((m) => {
      const spec = piano.strings.find((s) => s.midi === m.midi)!;
      const diff = ((m.b - spec.bTheory) / spec.bTheory) * 100;
      return el(
        'tr',
        { class: 'measured' },
        el('td', { text: midiToName(m.midi) }),
        el('td', { text: String(m.midi) }),
        el('td', { text: fmtSci(m.b) }),
        el('td', { text: fmtSci(spec.bTheory) }),
        el(
          'td',
          {},
          el(
            'span',
            {
              class: `pill ${Math.abs(diff) <= 10 ? 'good' : 'warn'}`,
              text: `${fmt(diff, 2)} %`,
            },
          ),
        ),
        el('td', { text: `${m.partialsUsed} 分音 / R² ${fmt(m.r2, 4)}` }),
      );
    });
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
            el('th', { text: '实测 B' }),
            el('th', { text: '理论 B' }),
            el('th', { text: '偏差' }),
            el('th', { text: '拟合质量' }),
          ),
        ),
        el(
          'tbody',
          {},
          ...(rows.length
            ? rows
            : [el('tr', {}, el('td', { colspan: '6', text: '暂无实测数据,曲线基于弦列理论 B 求解' }))]),
        ),
      ),
    );
    tableCard.append(wrap);
    page.append(tableCard);

    this.host.append(page);

    requestAnimationFrame(() => {
      this.drawCurve(targets, measurements);
      this.drawB(bTable.values, measurements, piano.strings[0].midi);
    });
  }

  private drawCurve(
    targets: { midi: number; centsOffset: number }[],
    measurements: { midi: number }[],
  ): void {
    const own = targets.map((t) => ({ midi: t.midi, cents: t.centsOffset }));
    const railsback = own.map((p) => ({
      midi: p.midi,
      cents: railsbackCents(p.midi),
    }));
    // 实测键的曲线位置
    const measured = measurements.map((m) => {
      const t = targets.find((x) => x.midi === m.midi)!;
      return { midi: m.midi, cents: t.centsOffset };
    });
    drawTuningCurve(this.curveCanvas, { own, railsback, measured });
  }

  private drawB(
    values: number[],
    measurements: { midi: number; b: number }[],
    midi0: number,
  ): void {
    const canvas = this.bCanvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    const logs = values.map((v) => Math.log10(v));
    const yMin = Math.floor(Math.min(...logs));
    const yMax = Math.ceil(Math.max(...logs));
    const xOf = (midi: number) =>
      ((midi - 21) / 87) * (w - 46) + 38;
    const yOf = (lv: number) =>
      h - 28 - ((lv - yMin) / (yMax - yMin)) * (h - 48);

    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.fillStyle = '#6b7a99';
    ctx.font = '11px system-ui';
    for (let lv = yMin; lv <= yMax; lv++) {
      const y = yOf(lv);
      ctx.beginPath();
      ctx.moveTo(38, y);
      ctx.lineTo(w - 8, y);
      ctx.stroke();
      ctx.fillText(`1e${lv}`, 6, y + 4);
    }

    ctx.strokeStyle = '#4dd0e1';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = xOf(midi0 + i);
      const y = yOf(Math.log10(v));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = '#66bb6a';
    for (const m of measurements) {
      const idx = m.midi - midi0;
      const v = values[idx];
      if (v === undefined) continue;
      ctx.beginPath();
      ctx.arc(xOf(m.midi), yOf(Math.log10(v)), 5, 0, Math.PI * 2);
      ctx.fill();
    }
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
}
