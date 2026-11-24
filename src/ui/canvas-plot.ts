/**
 * Canvas 频谱/曲线绘制工具(HiDPI 适配)
 */

import { Peak } from '../math/fft';

export function setupHiDpi(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  return ctx;
}

export interface SpectrumDrawOptions {
  magnitude: Float32Array;
  binHz: number;
  fftSize: number;
  peaks?: Peak[];
  /** 模型预测的分音位置 Hz */
  expectedPartials?: number[];
  /** 实测匹配峰 Hz */
  matchedFrequencies?: number[];
  maxFreq?: number;
}

export function drawSpectrum(
  canvas: HTMLCanvasElement,
  opts: SpectrumDrawOptions,
): void {
  const ctx = setupHiDpi(canvas);
  const w = canvas.getBoundingClientRect().width;
  const h = canvas.getBoundingClientRect().height;
  ctx.clearRect(0, 0, w, h);

  const maxFreq = opts.maxFreq ?? 5000;
  const bins = opts.magnitude.length;
  // magnitude 是 2 倍下采样:bin i 对应原 bin 2i
  const maxBin = Math.min(bins - 1, Math.floor(maxFreq / opts.binHz / 2));
  let maxMag = 1e-9;
  for (let i = 0; i <= maxBin; i++) {
    if (opts.magnitude[i] > maxMag) maxMag = opts.magnitude[i];
  }

  // 网格
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.font = '10px system-ui';
  ctx.fillStyle = '#6b7a99';
  for (let f = 0; f <= maxFreq; f += 500) {
    const x = (f / maxFreq) * w;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h - 16);
    ctx.stroke();
    ctx.fillText(`${f}`, x + 3, h - 4);
  }

  // 幅值谱(对数纵轴)
  ctx.strokeStyle = '#4dd0e1';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (let i = 1; i <= maxBin; i++) {
    const freq = i * 2 * opts.binHz;
    const x = (freq / maxFreq) * w;
    const db = 20 * Math.log10(opts.magnitude[i] / maxMag);
    const y = h - 16 + (db / 70) * (h - 24);
    if (i === 1) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // 预测分音(紫色竖线)
  if (opts.expectedPartials) {
    ctx.strokeStyle = 'rgba(179,157,219,0.85)';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.2;
    for (const f of opts.expectedPartials) {
      if (f > maxFreq) break;
      const x = (f / maxFreq) * w;
      ctx.beginPath();
      ctx.moveTo(x, 4);
      ctx.lineTo(x, h - 16);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // 匹配峰(绿色圆点)
  if (opts.matchedFrequencies) {
    ctx.fillStyle = '#66bb6a';
    for (const f of opts.matchedFrequencies) {
      if (f > maxFreq) continue;
      const x = (f / maxFreq) * w;
      ctx.beginPath();
      ctx.arc(x, 12, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 全部局部峰(橙色小标记)
  if (opts.peaks) {
    ctx.fillStyle = 'rgba(255,167,38,0.9)';
    for (const p of opts.peaks) {
      if (p.frequency > maxFreq) continue;
      const x = (p.frequency / maxFreq) * w;
      ctx.fillRect(x - 1, h - 20, 2, 4);
    }
  }
}

export interface CurvePoint {
  midi: number;
  cents: number;
}

/** 调律曲线:本琴曲线 + Railsback 参考 + 实测点 */
export function drawTuningCurve(
  canvas: HTMLCanvasElement,
  series: {
    own: CurvePoint[];
    railsback: CurvePoint[];
    measured: CurvePoint[];
  },
): void {
  const ctx = setupHiDpi(canvas);
  const w = canvas.getBoundingClientRect().width;
  const h = canvas.getBoundingClientRect().height;
  ctx.clearRect(0, 0, w, h);

  const midiMin = 21;
  const midiMax = 108;
  const all = [...series.own, ...series.railsback];
  let cMin = Math.min(-5, ...all.map((p) => p.cents));
  let cMax = Math.max(5, ...all.map((p) => p.cents));
  const pad = (cMax - cMin) * 0.08;
  cMin -= pad;
  cMax += pad;

  const xOf = (midi: number) =>
    ((midi - midiMin) / (midiMax - midiMin)) * (w - 46) + 38;
  const yOf = (cents: number) =>
    h - 30 - ((cents - cMin) / (cMax - cMin)) * (h - 50);

  // 网格 + 轴标签
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.fillStyle = '#6b7a99';
  ctx.font = '11px system-ui';
  ctx.lineWidth = 1;
  for (let c = Math.ceil(cMin / 10) * 10; c <= cMax; c += 10) {
    const y = yOf(c);
    ctx.beginPath();
    ctx.moveTo(38, y);
    ctx.lineTo(w - 8, y);
    ctx.stroke();
    ctx.fillText(`${c > 0 ? '+' : ''}${c}¢`, 6, y + 4);
  }
  const octaves = [21, 33, 45, 57, 69, 81, 93, 105];
  ctx.textAlign = 'center';
  for (const m of octaves) {
    const x = xOf(m);
    ctx.beginPath();
    ctx.moveTo(x, 12);
    ctx.lineTo(x, h - 30);
    ctx.stroke();
    const oct = Math.floor(m / 12) - 1;
    ctx.fillText(`C${oct}`, x, h - 12);
  }
  // 零线
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.beginPath();
  ctx.moveTo(38, yOf(0));
  ctx.lineTo(w - 8, yOf(0));
  ctx.stroke();

  const drawLine = (pts: CurvePoint[], color: string, width: number, dash: number[] = []) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = xOf(p.midi);
      const y = yOf(p.cents);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  };

  drawLine(series.railsback, 'rgba(179,157,219,0.85)', 1.8, [6, 5]);
  drawLine(series.own, '#4dd0e1', 2.4);

  // 实测点
  ctx.fillStyle = '#66bb6a';
  for (const p of series.measured) {
    ctx.beginPath();
    ctx.arc(xOf(p.midi), yOf(p.cents), 4.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.textAlign = 'start';
}
