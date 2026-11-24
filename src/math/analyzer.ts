/**
 * 实时分析器
 *
 * 消费 worklet 帧,做刚性弦模型下的多泛音融合测频:
 * 每个可追踪分音都反推出一个基频估计,按能量加权融合,
 * 长 FFT 窗(4096)的抛物线插值 + 多分音平均,可稳定到 0.5 音分以内。
 */

import { AnalysisFrame } from '../audio/engine';
import { BeatResult, TunerReading } from '../types';
import { ratioToCents } from './acoustics';
import {
  f1FromPartial,
  matchAndFit,
  partialFrequency,
} from './inharmonic';
import { strongestPeakIn, type Peak } from './fft';
import { detectUnisons } from './beats';

export interface LiveTunerConfig {
  midi: number;
  targetFrequency: number;
  b: number;
  maxPartials?: number;
  maxFreq?: number;
  /** 分音搜索窗 ±比例 */
  tolerance?: number;
}

interface SmoothedState {
  f1: number;
  initialized: boolean;
}

export class LiveTuner {
  private cfg: LiveTunerConfig;
  private smooth: SmoothedState = { f1: 0, initialized: false };
  /** 音分时间平滑系数(帧间 EMA) */
  smoothingAlpha = 0.45;

  constructor(cfg: LiveTunerConfig) {
    this.cfg = { maxPartials: 10, maxFreq: 5500, tolerance: 0.01, ...cfg };
  }

  update(next: Partial<LiveTunerConfig>): void {
    this.cfg = { ...this.cfg, ...next };
  }

  reset(): void {
    this.smooth = { f1: 0, initialized: false };
  }

  process(frame: AnalysisFrame): TunerReading | null {
    const { targetFrequency, b, maxPartials, maxFreq, tolerance, midi } =
      this.cfg;
    const votes: { f1: number; weight: number; n: number }[] = [];

    for (let n = 1; n <= maxPartials!; n++) {
      const expected = partialFrequency(targetFrequency, b, n);
      if (expected > maxFreq!) break;
      const peak = strongestPeakIn(
        frame.peaks,
        expected * (1 - tolerance!),
        expected * (1 + tolerance!),
      );
      if (peak) {
        votes.push({
          f1: f1FromPartial(peak.frequency, b, n),
          // 高分音每个 FFT 窗内周期更多,抛物线插值的分数 bin 误差更小,
          // 按分音序号 n 加权可显著降低低频键的整体读数误差
          weight: peak.magnitude * n,
          n,
        });
      }
    }

    if (votes.length === 0 || frame.rms < 0.002) return null;

    let wSum = 0;
    let fSum = 0;
    for (const v of votes) {
      fSum += v.f1 * v.weight;
      wSum += v.weight;
    }
    const rawF1 = fSum / wSum;

    // 离群剔除:与加权均值相差 > 3 音分的投票丢弃后重算
    const kept = votes.filter(
      (v) => Math.abs(ratioToCents(v.f1, rawF1)) < 3,
    );
    let w2 = 0;
    let f2 = 0;
    for (const v of kept) {
      f2 += v.f1 * v.weight;
      w2 += v.weight;
    }
    const cleanF1 = f2 / w2;

    // EMA 时间平滑
    if (!this.smooth.initialized) {
      this.smooth.f1 = cleanF1;
      this.smooth.initialized = true;
    } else {
      this.smooth.f1 =
        this.smoothingAlpha * cleanF1 +
        (1 - this.smoothingAlpha) * this.smooth.f1;
    }

    const confidence = Math.min(
      1,
      (kept.length / 4) * Math.min(1, frame.rms * 8),
    );

    return {
      midi,
      fundamental: this.smooth.f1,
      centsError: ratioToCents(this.smooth.f1, targetFrequency),
      partials: kept.length,
      confidence,
    };
  }
}

export interface MeasureResult {
  f1: number;
  b: number;
  r2: number;
  partialsUsed: number;
  partialFrequencies: number[];
  missingPartials: number[];
}

/**
 * 测弦:对单帧(必要时多帧取峰并集)做分音匹配 + B 拟合。
 * 多帧合并可抑制随机噪声导致的个别分音丢失。
 */
export function measureString(
  frames: AnalysisFrame[],
  approxF1: number,
  opts: { maxPartials?: number; maxFreq?: number; roughB?: number } = {},
): MeasureResult {
  if (frames.length === 0) throw new Error('没有可用的分析帧');
  // 选 RMS 最大的帧为主,补充其余帧中出现的峰
  const main = frames.reduce((a, b) => (a.rms > b.rms ? a : b));
  const merged = new Map<number, Peak>();
  for (const fr of frames) {
    for (const p of fr.peaks) {
      const key = Math.round(p.frequency * 2); // 0.5 Hz 量化合并
      const exist = merged.get(key);
      if (!exist || p.magnitude > exist.magnitude) merged.set(key, p);
    }
  }
  const peaks = Array.from(merged.values()).sort(
    (a, b) => a.frequency - b.frequency,
  );

  const fit = matchAndFit(peaks, approxF1, {
    maxPartials: opts.maxPartials ?? 16,
    maxFreq: opts.maxFreq ?? 6000,
    roughB: opts.roughB,
  });

  return {
    f1: fit.f1,
    b: fit.b,
    r2: fit.r2,
    partialsUsed: fit.partials.length,
    partialFrequencies: fit.partials.map((p) => p.frequency),
    missingPartials: fit.missingPartials,
  };
}

/** 同音弦拍频分析(透传 math 层,供 UI 统一从分析器调用) */
export function analyzeUnisons(
  frame: AnalysisFrame,
  approxF1: number,
  b: number,
  targetFrequency?: number,
): BeatResult {
  return detectUnisons(frame.peaks, approxF1, b, { targetFrequency });
}
