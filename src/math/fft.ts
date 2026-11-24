/**
 * 迭代 radix-2 FFT 与频谱工具
 * 输出幅值谱,并提供局部峰搜索与抛物线插值,用于亚 bin 级测频。
 */

export interface Peak {
  /** 插值后的频率 Hz */
  frequency: number;
  /** 线性幅值 */
  magnitude: number;
  /** 最近的 bin 索引 */
  bin: number;
}

/** 迭代 Cooley–Tukey FFT,re / im 长度必须为 2 的幂,原地计算 */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (((n - 1) & n) !== 0) throw new Error('FFT 长度必须为 2 的幂');

  // 位反转置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      for (let k = 0; k < half; k++) {
        const aR = re[i + k];
        const aI = im[i + k];
        const bR = re[i + k + half] * curR - im[i + k + half] * curI;
        const bI = re[i + k + half] * curI + im[i + k + half] * curR;
        re[i + k] = aR + bR;
        im[i + k] = aI + bI;
        re[i + k + half] = aR - bR;
        im[i + k + half] = aI - bI;
        const nxtR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nxtR;
      }
    }
  }
}

/** Hann 窗(减少频谱泄漏,利于峰插值) */
export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  return w;
}

export interface Spectrum {
  /** 单边幅值谱(长度 n/2+1) */
  magnitude: Float64Array;
  /** bin 间距 Hz */
  binHz: number;
  nfft: number;
  sampleRate: number;
}

/** 不小于 n 的最小 2 的幂 */
export function nextPow2(n: number): number {
  return 1 << (n - 1).toString(2).length;
}

/** 对一段实信号加 Hann 窗后做 FFT,返回单边幅值谱;非 2 幂长度自动补零 */
export function computeSpectrum(
  samples: Float32Array | Float64Array,
  sampleRate: number,
): Spectrum {
  const nIn = samples.length;
  const n = nextPow2(nIn);
  const win = hannWindow(nIn);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  // 窗的相干增益,补偿幅值(按实际样本数计算)
  let coherentGain = 0;
  for (let i = 0; i < nIn; i++) {
    re[i] = samples[i] * win[i];
    coherentGain += win[i];
  }
  coherentGain /= nIn;
  fft(re, im);

  const half = n >> 1;
  const mag = new Float64Array(half + 1);
  const scale = 2 / (nIn * coherentGain);
  for (let k = 0; k <= half; k++) {
    mag[k] = Math.hypot(re[k], im[k]) * scale;
  }
  mag[0] /= 2;
  mag[half] /= 2;
  return { magnitude: mag, binHz: sampleRate / n, nfft: n, sampleRate };
}

/**
 * 局部极大值峰搜索 + 三点抛物线插值(Quadratic interpolation)
 * 插值精度在高信噪比下优于 0.1 bin,配合长窗足以支撑 0.5 音分读数。
 */
export function findPeaks(spec: Spectrum, minMagRatio = 0.008): Peak[] {
  const { magnitude, binHz } = spec;
  let maxMag = 0;
  for (let k = 1; k < magnitude.length - 1; k++) {
    if (magnitude[k] > maxMag) maxMag = magnitude[k];
  }
  // 绝对地板:全局最大值的 0.8%,足以抓住滚降的高分音,
  // 同时局部峰判据(高于两侧两格)抑制噪声虚峰
  const floor = maxMag * minMagRatio;
  const peaks: Peak[] = [];

  for (let k = 2; k < magnitude.length - 2; k++) {
    const m = magnitude[k];
    if (
      m > floor &&
      m > magnitude[k - 1] &&
      m >= magnitude[k + 1] &&
      m > magnitude[k - 2] &&
      m > magnitude[k + 2]
    ) {
      // 抛物线顶点偏移(单位:bin)
      const a = magnitude[k - 1];
      const b = magnitude[k];
      const c = magnitude[k + 1];
      const denom = a - 2 * b + c;
      const shift = denom !== 0 ? 0.5 * (a - c) / denom : 0;
      peaks.push({
        bin: k,
        frequency: (k + shift) * binHz,
        magnitude: b - 0.25 * (a - c) * shift,
      });
    }
  }
  return peaks;
}

/** 在指定频率窗内找幅值最大的峰,找不到返回 null */
export function strongestPeakIn(
  peaks: Peak[],
  fLow: number,
  fHigh: number,
): Peak | null {
  let best: Peak | null = null;
  for (const p of peaks) {
    if (p.frequency >= fLow && p.frequency <= fHigh) {
      if (!best || p.magnitude > best.magnitude) best = p;
    }
  }
  return best;
}
