/**
 * 整琴非谐系数建模与拉伸调律曲线求解
 *
 * 思路:
 * 1. 实测若干键的 B 后,在 log(B)-MIDI 平面做加权二次拟合,
 *    结合每键理论 B 做平滑回退,得到 88 键完整 B 表;
 * 2. 以"八度(2:1)、十二度(3:1)、双八度(4:1)分音拍频最小"为目标,
 *    建立音分偏离量的线性方程组,Gauss–Seidel 迭代求解拉伸曲线。
 */

import { Measurement, PianoProfile, StringSpec, TuningTarget } from '../types';
import { midiToFreq, ratioToCents } from './acoustics';
import { partialFrequency, theoreticalB } from './inharmonic';

/**
 * 分音相对自身基频的音程(音分)。
 * 第 n 分音 = n·sqrt(1+B n²) 倍基频。
 */
function partialCents(b: number, n: number): number {
  return 1200 * Math.log2(n * Math.sqrt(1 + b * n * n));
}

export interface BTable {
  /** 88 键 B 值,索引 0 对应 MIDI 21 */
  values: number[];
  /** 每个键的 B 来源:'measured' | 'fitted' | 'theory' */
  sources: ('measured' | 'fitted' | 'theory')[];
  /** log B 二次拟合系数,用于曲线页展示 */
  logFit: { c0: number; c1: number; c2: number };
}

/** 加权二次拟合 z = c0 + c1 x + c2 x²(权重数组可选) */
function weightedQuadratic(
  xs: number[],
  zs: number[],
  ws: number[],
): { c0: number; c1: number; c2: number } {
  // 正规方程 6x6
  const a = Array.from({ length: 6 }, () => new Array(6).fill(0));
  const rhs = new Array(6).fill(0);
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    const z = zs[i];
    const w = ws[i];
    const basis = [1, x, x * x, x ** 3, x ** 4, x ** 5];
    const row = [1, x, x * x];
    for (let r = 0; r < 3; r++) {
      rhs[r] += w * row[r] * z;
      for (let c = 0; c < 3; c++) a[r][c] += w * row[r] * row[c];
    }
    void basis;
  }
  // 解 3x3(只需前 3 阶)
  const m = [a[0].slice(0, 3), a[1].slice(0, 3), a[2].slice(0, 3)];
  const y = rhs.slice(0, 3);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    }
    [m[col], m[piv]] = [m[piv], m[col]];
    [y[col], y[piv]] = [y[piv], y[col]];
    const d = m[col][col] || 1e-300;
    for (let c = 0; c < 3; c++) m[col][c] /= d;
    y[col] /= d;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col];
      for (let c = 0; c < 3; c++) m[r][c] -= f * m[col][c];
      y[r] -= f * y[col];
    }
  }
  return { c0: y[0], c1: y[1], c2: y[2] };
}

/**
 * 构建 88 键 B 表。
 * 实测点优先;实测点 ≥3 个时做 log B 二次曲面;
 * 其余键取"理论 B 与拟合 B 的加权融合",实测稀疏时偏向理论值。
 */
export function buildBTable(
  profile: PianoProfile,
  measurements: Measurement[],
): BTable {
  const strings = profile.strings;
  const measured = new Map<number, Measurement>();
  for (const m of measurements) measured.set(m.midi, m);

  const sources: BTable['sources'] = strings.map((s) =>
    measured.has(s.midi) ? 'measured' : 'theory',
  );

  // 理论 B 兜底(数据异常时也能工作)
  const theory = strings.map((s) =>
    Math.max(1e-8, s.bTheory || theoreticalB(s.length, s.diameter, s.tension)),
  );

  let logFit = { c0: 0, c1: 0, c2: 0 };
  const values = theory.slice();

  if (measured.size >= 2) {
    const xs: number[] = [];
    const zs: number[] = [];
    const ws: number[] = [];
    for (const m of measured.values()) {
      xs.push(m.midi);
      zs.push(Math.log(m.b));
      // R² 越高、分音越多,权重越大
      ws.push(m.partialsUsed * Math.max(0.1, m.r2));
    }
    if (measured.size === 2) {
      // 两点只能定直线:复用二次求解器但 c2 由理论走势补
      const slope = (zs[1] - zs[0]) / (xs[1] - xs[0]);
      logFit = {
        c1: slope,
        c0: zs[0] - slope * xs[0],
        c2: 0,
      };
    } else {
      logFit = weightedQuadratic(xs, zs, ws);
    }

    const nMeasured = measured.size;
    for (let i = 0; i < strings.length; i++) {
      const x = strings[i].midi;
      const fittedB = Math.exp(
        logFit.c0 + logFit.c1 * x + logFit.c2 * x * x,
      );
      if (measured.has(x)) {
        values[i] = measured.get(x)!.b;
        sources[i] = 'measured';
      } else {
        // 实测点越多越信任拟合;且离实测区越远越回退理论值
        const nearest = Math.min(
          ...Array.from(measured.keys()).map((k) => Math.abs(k - x)),
        );
        const trust = Math.min(
          1,
          (nMeasured / 12) * Math.exp(-nearest / 25),
        );
        values[i] = Math.exp(
          trust * Math.log(fittedB) + (1 - trust) * Math.log(theory[i]),
        );
        sources[i] = trust > 0.5 ? 'fitted' : 'theory';
      }
    }
  }

  return { values, sources, logFit };
}

interface IntervalSpec {
  /** 上方键距(半音数) */
  span: number;
  /** 下键分音序号 */
  p: number;
  /** 上键分音序号 */
  q: number;
  weight: number;
}

/** 主要协和音程:八度 2:1、十二度 3:1、双八度 4:1,另含 6:3 双八度校验 */
const INTERVALS: IntervalSpec[] = [
  { span: 12, p: 2, q: 1, weight: 1.0 },
  { span: 19, p: 3, q: 1, weight: 0.65 },
  { span: 24, p: 4, q: 1, weight: 0.45 },
  { span: 24, p: 6, q: 3, weight: 0.25 },
];

/**
 * 最小拍频拉伸曲线。
 *
 * 对音程(下键 lo,上键 hi=lo+span)的分音对 (p,q),
 * 无拍条件为两键的分音频率相等:
 *   f_lo·p·√(1+B_lo p²) = f_hi·q·√(1+B_hi q²)
 * 平均律下 f_hi/f_lo = 2^(span/12),记 c 为相对平均律的音分偏离,
 * 线性化后约束(整数比项被平均律基准抵消,只剩非谐修正):
 *   c_hi − c_lo = 1200·log2[ √(1+B_lo p²) / √(1+B_hi q²) ]
 * 加平滑正则与 A4 锚点后解带权最小二乘。
 */
export function solveStretchCurve(
  profile: PianoProfile,
  bTable: BTable,
  anchorMidi = 69,
): TuningTarget[] {
  const strings = profile.strings;
  const n = strings.length;
  const midi0 = strings[0].midi;
  const idxOf = (midi: number) => midi - midi0;
  const bAt = (midi: number) => bTable.values[idxOf(midi)];

  // 约束的稀疏表示:每条约束涉及两个变量
  interface Constraint {
    lo: number;
    hi: number;
    target: number;
    weight: number;
  }
  const constraints: Constraint[] = [];

  for (const s of strings) {
    const lo = s.midi;
    for (const iv of INTERVALS) {
      const hi = lo + iv.span;
      if (hi > strings[n - 1].midi) continue;
      // 所需分音频率超出钢琴有效泛音范围则降权/跳过
      const fLoPartial = partialFrequency(
        midiToFreq(lo),
        bAt(lo),
        iv.p,
      );
      if (fLoPartial > 7500) continue;
      const target =
        1200 *
        Math.log2(
          Math.sqrt(1 + bAt(lo) * iv.p * iv.p) /
            Math.sqrt(1 + bAt(hi) * iv.q * iv.q),
        );
      constraints.push({
        lo: idxOf(lo),
        hi: idxOf(hi),
        target,
        weight: iv.weight,
      });
    }
  }

  // 构建带权最小二乘的正规方程:A·x = b
  // 每条无拍约束  c_hi − c_lo = target,贡献权重 w;
  // 另有相邻平滑正则  c_i − c_{i+1} = 0,以及 A4 强锚点 c_anchor = 0。
  const N = n;
  const diag = new Array(N).fill(0);
  const rhs = new Array(N).fill(0);
  /** 邻接表:off[i] = [[j, -w], ...],约束贡献的非对角项 */
  const off: [number, number][][] = Array.from({ length: N }, () => []);
  const smooth = 0.12;

  for (const c of constraints) {
    diag[c.lo] += c.weight;
    diag[c.hi] += c.weight;
    rhs[c.lo] += -c.weight * c.target; // 行 lo:系数 (lo=+w, hi=-w),右端 -w·target
    rhs[c.hi] += c.weight * c.target; // 行 hi:系数 (hi=+w, lo=-w),右端 +w·target
    off[c.lo].push([c.hi, -c.weight]);
    off[c.hi].push([c.lo, -c.weight]);
  }

  // 平滑正则
  for (let i = 0; i < N - 1; i++) {
    diag[i] += smooth;
    diag[i + 1] += smooth;
    off[i].push([i + 1, -smooth]);
    off[i + 1].push([i, -smooth]);
  }

  // 弱平均律先验:让无充分音程约束的端点不漂移,
  // 权重远小于真实拍频约束,只起边界稳定作用
  const etPrior = 0.012;
  for (let i = 0; i < N; i++) {
    diag[i] += etPrior;
    // rhs 目标 0,无需累加
  }

  // A4 锚点(大权重,等价于固定边界)
  const anchorIdx = idxOf(anchorMidi);
  const anchorW = 1e6;
  diag[anchorIdx] += anchorW;
  rhs[anchorIdx] += 0;

  // Jacobi 迭代(矩阵严格对角占优,保证收敛)
  let x = new Array(N).fill(0);
  for (let iter = 0; iter < 2000; iter++) {
    const next = new Array(N).fill(0);
    let maxDelta = 0;
    for (let i = 0; i < N; i++) {
      let sum = rhs[i];
      for (const [j, aij] of off[i]) sum -= aij * x[j];
      next[i] = sum / diag[i];
      maxDelta = Math.max(maxDelta, Math.abs(next[i] - x[i]));
    }
    x = next;
    if (maxDelta < 1e-6) break;
  }

  // 锚点平移归零(数值保险)
  const shift = x[anchorIdx];
  return strings.map((s, i) => {
    const centsOffset = x[i] - shift;
    const frequency = midiToFreq(s.midi) * Math.pow(2, centsOffset / 1200);
    return { midi: s.midi, frequency, centsOffset };
  });
}

/**
 * 计算两个音指定分音对的拍频 Hz(调律页辅助显示)。
 * 拍频 = 两个分音频率之差的绝对值。
 */
export function beatRateHz(
  fLo: number,
  bLo: number,
  p: number,
  fHi: number,
  bHi: number,
  q: number,
): number {
  const a = partialFrequency(fLo, bLo, p);
  const b = partialFrequency(fHi, bHi, q);
  return Math.abs(a - b);
}

/** 音分偏差便捷封装 */
export function centsBetween(fMeasured: number, fTarget: number): number {
  return ratioToCents(fMeasured, fTarget);
}

/** 给 UI 用:某键理论 B 直接计算 */
export function theoryBOf(s: StringSpec): number {
  return theoreticalB(s.length, s.diameter, s.tension);
}
