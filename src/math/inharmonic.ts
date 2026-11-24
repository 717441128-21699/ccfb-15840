/**
 * 刚性弦非谐性模型
 *
 * 理想柔性弦 f_n = n f_1;实际钢琴弦有抗弯刚度,Young 弦模型:
 *
 *   f_n = n f_1 · sqrt(1 + B n²)
 *
 * B 即非谐系数(inharmonicity constant),典型值 1e-5(长裸弦)~ 1e-3(短缠弦)。
 */

import { Peak, strongestPeakIn } from './fft';

/** 杨氏模量,钢琴高碳钢丝 ~2.0e11 Pa */
export const STEEL_YOUNG = 2.0e11;
/** 钢密度 kg/m³ */
export const STEEL_DENSITY = 7850;

/** 给定基频与 B,计算第 n 分音频率(n 从 1 开始) */
export function partialFrequency(f1: number, b: number, n: number): number {
  return n * f1 * Math.sqrt(1 + b * n * n);
}

/**
 * 由弦的几何/材料参数计算理论 B(Young–Fletcher 非谐系数)。
 *
 * 刚性弦方程 μ ÿ = T y″ − EI y⁗,代入简支模态 sin(nπx/L) 得:
 *   f_n = n f_1 √(1 + B n²),  B = π² E I /(T L²)
 * 圆截面惯性矩 I = π d⁴/64,故:
 *   B = π³ E d⁴ / (64 T L²)
 * 缠弦刚度由钢芯承担,d 取芯线直径;张力为整弦总张力。
 *
 * @param length   有效弦长 L(m)
 * @param coreDiam 钢芯直径 d(m)(裸弦即线径)
 * @param tension  总张力 T(N)
 */
export function theoreticalB(
  length: number,
  coreDiam: number,
  tension: number,
): number {
  const L = length;
  const d4 = coreDiam ** 4;
  return (Math.PI ** 3 * STEEL_YOUNG * d4) / (64 * tension * L * L);
}

export interface InharmonicFit {
  f1: number;
  b: number;
  r2: number;
  partials: { n: number; frequency: number; predicted: number; weight: number }[];
}

/**
 * 线性化加权最小二乘拟合。
 *
 *   (f_n / n)² = f_1² (1 + B n²) = a + c n²,a = f_1²,c = B f_1²
 *
 * 故 y = (f_n/n)² 对 x = n² 做加权直线拟合:
 *   f_1 = sqrt(a),B = c / a
 */
export function fitInharmonic(
  observations: { n: number; frequency: number; weight?: number }[],
): InharmonicFit {
  const pts = observations
    .filter((o) => o.frequency > 0 && o.n >= 1)
    .map((o) => ({
      n: o.n,
      x: o.n * o.n,
      y: (o.frequency / o.n) ** 2,
      w: o.weight ?? 1,
      f: o.frequency,
    }));
  if (pts.length < 3) {
    throw new Error('至少需要 3 个分音才能拟合非谐系数');
  }

  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (const p of pts) {
    sw += p.w;
    sx += p.w * p.x;
    sy += p.w * p.y;
    sxy += p.w * p.x * p.y;
    sxx += p.w * p.x * p.x;
  }
  const denom = sw * sxx - sx * sx;
  const a = (sy * sxx - sx * sxy) / denom;
  const c = (sw * sxy - sx * sy) / denom;
  if (a <= 0) throw new Error('拟合失败:f_1² 为非正');
  const f1 = Math.sqrt(a);
  const b = c / a;

  // 加权 R²
  const yMean = sy / sw;
  let ssTot = 0;
  let ssRes = 0;
  for (const p of pts) {
    const yHat = a + c * p.x;
    ssTot += p.w * (p.y - yMean) ** 2;
    ssRes += p.w * (p.y - yHat) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1;

  return {
    f1,
    b,
    r2,
    partials: pts.map((p) => ({
      n: p.n,
      frequency: p.f,
      predicted: partialFrequency(f1, b, p.n),
      weight: p.w,
    })),
  };
}

export interface MatchResult extends InharmonicFit {
  /** 未匹配上的分音序号 */
  missingPartials: number[];
}

/**
 * 以近似基频为先验,从频谱峰中逐个匹配前 maxPartials 个分音并拟合。
 * 两轮迭代:首轮用粗 B 估位置,拟合后用新 B 重新匹配,容忍调律偏差。
 */
export function matchAndFit(
  peaks: Peak[],
  approxF1: number,
  options: { maxPartials?: number; maxFreq?: number; roughB?: number } = {},
): MatchResult {
  const maxPartials = options.maxPartials ?? 16;
  const maxFreq = options.maxFreq ?? 6000;
  let b = options.roughB ?? 8e-5;
  let fit: InharmonicFit | null = null;
  let used: { n: number; frequency: number; weight: number }[] = [];
  let missing: number[] = [];

  for (let round = 0; round < 2; round++) {
    used = [];
    missing = [];
    for (let n = 1; n <= maxPartials; n++) {
      const expected = partialFrequency(approxF1, b, n);
      if (expected > maxFreq) break;
      // 首轮窗宽 ±3.5%(粗调状态也能抓住),次轮 ±1.2%
      const tol = round === 0 ? 0.035 : 0.012;
      const peak = strongestPeakIn(
        peaks,
        expected * (1 - tol),
        expected * (1 + tol),
      );
      if (peak) {
        used.push({ n, frequency: peak.frequency, weight: peak.magnitude });
      } else {
        missing.push(n);
      }
    }
    if (used.length < 3) {
      throw new Error(
        `仅匹配到 ${used.length} 个分音,信号过弱或环境噪声过大`,
      );
    }
    fit = fitInharmonic(used);
    // 用拟合出的 f1 修正先验,B 进入下一轮精匹配
    approxF1 = fit.f1;
    b = Math.max(1e-7, fit.b);
  }

  return { ...(fit as InharmonicFit), missingPartials: missing };
}

/**
 * 已知 B 时,由单个分音测量值反推基频。
 * 实时调音用:每个可追踪的分音给出一个 f1 估计再加权融合。
 */
export function f1FromPartial(fN: number, b: number, n: number): number {
  return fN / (n * Math.sqrt(1 + b * n * n));
}
