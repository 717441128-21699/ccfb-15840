/**
 * 刚性弦声音合成器
 *
 * 按 Young 模型 f_n = n f1 sqrt(1+B n²) 合成钢琴式音:
 * 多分音 + 分音差异化指数衰减 + 同音弦微失调 + 击弦噪声。
 * 既是"模拟弦演示"的信号源,也是单元测试的已知真值来源。
 */

import { partialFrequency } from '../math/inharmonic';

export interface SynthOptions {
  f1: number;
  b: number;
  /** 不填则由 AudioEngine 按 AudioContext 采样率注入 */
  sampleRate?: number;
  duration?: number;
  partials?: number;
  /** 同音弦数量 1..3 */
  unisons?: number;
  /** 每根同音弦相对 f1 的失调(音分),长度需等于 unisons */
  unisonDetuneCents?: number[];
  /** 随机种子(确定性输出) */
  seed?: number;
  /** 击弦噪声强度 0..1 */
  strikeNoise?: number;
}

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function synthesizeString(opts: SynthOptions): Float32Array {
  const {
    f1,
    b,
    sampleRate = 48000,
    duration = 2.5,
    partials = 20,
    unisons = 1,
    unisonDetuneCents,
    seed = 42,
    strikeNoise = 0.05,
  } = opts;

  const n = Math.floor(sampleRate * duration);
  const out = new Float32Array(n);
  const rng = makeRng(seed);

  const detunes =
    unisonDetuneCents ??
    Array.from({ length: unisons }, (_, i) =>
      unisons === 1 ? 0 : (i - (unisons - 1) / 2) * 1.2,
    );

  const activePartials = Math.min(
    partials,
    Math.floor((sampleRate / 2.2) / (f1 * Math.sqrt(1 + b))) ,
  );

  for (let u = 0; u < unisons; u++) {
    const f1u = f1 * Math.pow(2, (detunes[u] ?? 0) / 1200);
    for (let p = 1; p <= activePartials; p++) {
      const f = partialFrequency(f1u, b, p);
      if (f >= sampleRate / 2 - 100) break;
      // 钢琴频谱包络:低次分音强,高频滚降,3~6 次有一个小隆起
      let amp = 1 / Math.pow(p, 0.75);
      if (p >= 3 && p <= 6) amp *= 1.25;
      amp *= Math.exp(-((f - 900) ** 2) / (2 * 2200 ** 2)) + 0.18;
      // 衰减:高频衰减更快,但保证窗内各分音仍有可观能量
      // 实测钢琴弦中高分音时间常数普遍 1~4 秒
      const tau = Math.max(1.1, 5.5 / Math.pow(p, 0.9));
      const phase = rng() * Math.PI * 2;
      const attack = 0.004;
      const norm = 1 / unisons;
      for (let i = 0; i < n; i++) {
        const t = i / sampleRate;
        const envA = Math.min(1, t / attack);
        const env = envA * Math.exp(-t / tau);
        out[i] += norm * amp * env * Math.sin(2 * Math.PI * f * t + phase);
      }
    }
  }

  // 击弦瞬态:短脉冲式宽带噪声
  if (strikeNoise > 0) {
    const noiseLen = Math.floor(sampleRate * 0.02);
    let lp = 0;
    for (let i = 0; i < noiseLen; i++) {
      const white = rng() * 2 - 1;
      lp = 0.35 * lp + 0.65 * white;
      const env = Math.exp(-i / (noiseLen * 0.35));
      out[i] += strikeNoise * lp * env;
    }
  }

  // 归一化防削波
  let peak = 1e-9;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const gain = Math.min(1, 0.9 / peak);
  for (let i = 0; i < n; i++) out[i] *= gain;

  return out;
}

/** 渲染为 Web Audio AudioBuffer(演示模式播放用) */
export function toAudioBuffer(
  ctx: BaseAudioContext,
  samples: Float32Array,
): AudioBuffer {
  const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  buf.copyToChannel(new Float32Array(samples), 0);
  return buf;
}
