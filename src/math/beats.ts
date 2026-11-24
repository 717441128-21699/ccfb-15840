/**
 * 同音弦(unison)拍频检测
 *
 * 一个键有 2~3 根同音弦,若未调齐,每个分音位置会裂成 2~3 个紧挨的峰。
 * 主方法:在各分音窗内收集裂峰 → 反推各弦基频 → 一维聚类得到每根弦;
 * 辅助验证:对强分音做带通 + 包络自相关,直接读振幅调制(拍)频率。
 */

import { Peak } from './fft';
import { f1FromPartial, partialFrequency } from './inharmonic';
import { ratioToCents } from './acoustics';
import { BeatResult } from '../types';

interface F1Vote {
  f1: number;
  weight: number;
  partial: number;
}

/** 一维聚类:按音分距离归并,返回每个簇的加权平均频率。
 * 容差 1.5 音分:同音弦失调通常 1~5 音分,过大会把相邻弦并成一簇 */
function clusterFrequencies(
  votes: F1Vote[],
  centsTol = 1.5,
): { f1: number; weight: number; partials: Set<number> }[] {
  const sorted = votes.slice().sort((a, b) => a.f1 - b.f1);
  const clusters: { f1: number; weight: number; partials: Set<number>; sum: number }[] = [];

  for (const v of sorted) {
    const last = clusters[clusters.length - 1];
    if (
      last &&
      Math.abs(ratioToCents(v.f1, last.f1)) <= centsTol
    ) {
      last.sum += v.f1 * v.weight;
      last.weight += v.weight;
      last.f1 = last.sum / last.weight;
      last.partials.add(v.partial);
    } else {
      clusters.push({
        f1: v.f1,
        sum: v.f1 * v.weight,
        weight: v.weight,
        partials: new Set([v.partial]),
      });
    }
  }
  return clusters.map(({ sum: _sum, ...rest }) => rest);
}

export interface UnisonOptions {
  maxPartials?: number;
  maxFreq?: number;
  /** 裂峰搜索窗(相对分音频率) */
  windowRatio?: number;
  targetFrequency?: number;
}

/**
 * 从频谱峰中分辨同一键的多根同音弦。
 * @param peaks    全频谱峰
 * @param approxF1 该键近似基频
 * @param b        该键非谐系数
 */
export function detectUnisons(
  peaks: Peak[],
  approxF1: number,
  b: number,
  opts: UnisonOptions = {},
): BeatResult {
  const maxPartials = opts.maxPartials ?? 8;
  const maxFreq = opts.maxFreq ?? 4500;
  const windowRatio = opts.windowRatio ?? 0.02;
  const votes: F1Vote[] = [];

  for (let n = 1; n <= maxPartials; n++) {
    const expected = partialFrequency(approxF1, b, n);
    if (expected > maxFreq) break;
    // 收集窗内所有峰(未裂时只有一个,裂峰时 2~3 个)
    const inWindow = peaks.filter(
      (p) =>
        p.frequency >= expected * (1 - windowRatio) &&
        p.frequency <= expected * (1 + windowRatio),
    );
    for (const p of inWindow) {
      votes.push({
        f1: f1FromPartial(p.frequency, b, n),
        weight: p.magnitude,
        partial: n,
      });
    }
  }

  const clusters = clusterFrequencies(votes)
    // 至少两个分音支持,或能量显著,才算一根独立弦
    .filter((c) => c.partials.size >= 2 || c.weight > 0)
    .sort((a, b2) => b2.weight - a.weight)
    .slice(0, 3)
    .sort((a, b2) => a.f1 - b2.f1);

  if (clusters.length === 0) {
    return { beatRates: [], stringFrequencies: [], stringCentsErrors: [] };
  }

  const stringFrequencies = clusters.map((c) => c.f1);
  const target = opts.targetFrequency ?? approxF1;
  const stringCentsErrors = stringFrequencies.map((f) => ratioToCents(f, target));

  // 拍频:选落在人耳最敏感区(500~2500 Hz)的最高分音计算
  let beatPartial = 1;
  for (let n = maxPartials; n >= 1; n--) {
    const f = partialFrequency(approxF1, b, n);
    if (f >= 400 && f <= 2500) {
      beatPartial = n;
      break;
    }
  }

  const beatRates: number[] = [];
  for (let i = 0; i < stringFrequencies.length; i++) {
    for (let j = i + 1; j < stringFrequencies.length; j++) {
      const fa = partialFrequency(stringFrequencies[i], b, beatPartial);
      const fb = partialFrequency(stringFrequencies[j], b, beatPartial);
      beatRates.push(Math.abs(fa - fb));
    }
  }

  return { beatRates, stringFrequencies, stringCentsErrors };
}

/** RBJ 带通滤波器系数(质量因子 Q) */
function biquadBandpass(
  sr: number,
  fc: number,
  q: number,
): { b0: number; b1: number; b2: number; a1: number; a2: number } {
  const w = (2 * Math.PI * fc) / sr;
  const cosw = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/**
 * 时域包络法估计拍频:带通取出某分音 → 整流 + 低通得包络 →
 * 包络自相关,在 0.5~15 Hz 范围内找首个显著周期。
 * 检测不到返回 null。
 */
export function envelopeBeatRate(
  samples: Float32Array,
  sampleRate: number,
  centerFreq: number,
): number | null {
  const bp = biquadBandpass(sampleRate, centerFreq, 25);
  const filtered = new Float32Array(samples.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y =
      bp.b0 * x + bp.b1 * x1 + bp.b2 * x2 - bp.a1 * y1 - bp.a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    filtered[i] = y;
  }

  // 整流 + 一阶低通(截止约 30 Hz)得振幅包络
  const cutoff = 30;
  const k = (2 * Math.PI * cutoff) / sampleRate;
  const alpha = k / (1 + k);
  const env = new Float32Array(filtered.length);
  let e = 0;
  let mean = 0;
  for (let i = 0; i < filtered.length; i++) {
    const rect = Math.abs(filtered[i]);
    e += alpha * (rect - e);
    env[i] = e;
    mean += e;
  }
  mean /= env.length;

  const minLag = Math.floor(sampleRate / 15); // 15 Hz
  const maxLag = Math.min(
    Math.floor(sampleRate / 0.5),
    Math.floor(env.length / 2),
  ); // 0.5 Hz
  let bestLag = -1;
  let bestVal = 0;
  let energy = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let ac = 0;
    for (let i = 0; i + lag < env.length; i++) {
      ac += (env[i] - mean) * (env[i + lag] - mean);
    }
    ac /= env.length - lag;
    if (lag === minLag) energy = Math.abs(ac);
    if (ac > bestVal) {
      bestVal = ac;
      bestLag = lag;
    }
  }
  // 显著性门槛:主峰明显高于零滞后能量的 15%
  if (bestLag < 0 || bestVal < 0.15 * energy) return null;
  return sampleRate / bestLag;
}

/** 便捷封装:在最强分音上做包络验证 */
export function envelopeConfirmBeat(
  samples: Float32Array,
  sampleRate: number,
  approxF1: number,
  b: number,
): number | null {
  // 选 800~2000 Hz 内最靠后的分音
  let chosen = partialFrequency(approxF1, b, 1);
  for (let n = 1; n <= 10; n++) {
    const f = partialFrequency(approxF1, b, n);
    if (f <= 2000) chosen = f;
  }
  return envelopeBeatRate(samples, sampleRate, chosen);
}
