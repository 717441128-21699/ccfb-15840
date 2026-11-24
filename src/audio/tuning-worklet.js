/**
 * 调律 AudioWorklet 处理器
 *
 * 在音频渲染线程完成:环形缓冲 → Hann 加窗 → radix-2 FFT →
 * 幅值谱 + 局部峰提取,结果以 Transferable 发回主线程。
 * 主线程只做刚性弦模型拟合与 UI,保证 UI 卡顿不影响音频采集。
 */

const HANN_CACHE = new Map();

function hannWindow(n) {
  let w = HANN_CACHE.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    }
    HANN_CACHE.set(n, w);
  }
  return w;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
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
        const ar = re[i + k];
        const ai = im[i + k];
        const br = re[i + k + half] * curR - im[i + k + half] * curI;
        const bi = re[i + k + half] * curI + im[i + k + half] * curR;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + half] = ar - br;
        im[i + k + half] = ai - bi;
        const nr = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nr;
      }
    }
  }
}

class TuningProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fftSize = 4096;
    this.ring = new Float32Array(this.fftSize);
    this.re = new Float64Array(this.fftSize);
    this.im = new Float64Array(this.fftSize);
    this.mag = new Float32Array(this.fftSize / 2 + 1);
    this.filled = 0;
    this.frameCount = 0;
    this.minPeakRatio = 0.008;
    this.rawRing = null; // 延迟到拿到 sampleRate 后分配,约 3 秒
    this.rawWrite = 0;
    this.sampleRate = 0;

    this.port.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.type === 'config') {
        if (msg.fftSize && msg.fftSize !== this.fftSize) {
          this.fftSize = msg.fftSize;
          this.ring = new Float32Array(this.fftSize);
          this.re = new Float64Array(this.fftSize);
          this.im = new Float64Array(this.fftSize);
          this.mag = new Float32Array(this.fftSize / 2 + 1);
          this.filled = 0;
        }
        if (typeof msg.minPeakRatio === 'number') {
          this.minPeakRatio = msg.minPeakRatio;
        }
      } else if (msg.type === 'snapshot') {
        if (this.rawRing) {
          // 按时间顺序导出环形缓冲副本
          const len = this.rawRing.length;
          const start = this.rawWrite % len;
          const copy = new Float32Array(len);
          copy.set(this.rawRing.subarray(start), 0);
          copy.set(this.rawRing.subarray(0, start), len - start);
          this.port.postMessage(
            {
              type: 'snapshot',
              sampleRate: this.sampleRate,
              samples: copy,
            },
            [copy.buffer],
          );
        }
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch) return true;

    // 环形写入
    const sr = sampleRate;
    this.sampleRate = sr;
    if (!this.rawRing) {
      this.rawRing = new Float32Array(Math.floor(sr * 3));
    }
    for (let i = 0; i < ch.length; i++) {
      this.ring[this.filled % this.fftSize] = ch[i];
      this.filled++;
      this.rawRing[this.rawWrite % this.rawRing.length] = ch[i];
      this.rawWrite++;
    }

    // 每 fftSize/2 个样本出一帧(50% 重叠)
    if (this.filled < this.fftSize) return true;
    const sinceLast = this.lastEmitFill ? this.filled - this.lastEmitFill : this.fftSize;
    if (sinceLast < this.fftSize / 2) return true;
    this.lastEmitFill = this.filled;

    const n = this.fftSize;
    const win = hannWindow(n);
    let cg = 0;
    let rms = 0;
    for (let i = 0; i < n; i++) {
      const s = this.ring[(this.filled - n + i) % n];
      this.re[i] = s * win[i];
      this.im[i] = 0;
      cg += win[i];
      rms += s * s;
    }
    cg /= n;
    rms = Math.sqrt(rms / n);

    fft(this.re, this.im);

    const half = n >> 1;
    const binHz = sr / n;
    const scale = 2 / (n * cg);
    let maxMag = 1e-12;
    for (let k = 0; k <= half; k++) {
      const m = Math.hypot(this.re[k], this.im[k]) * scale;
      this.mag[k] = m;
      if (k > 1 && k < half && m > maxMag) maxMag = m;
    }

    // 局部峰 + 抛物线插值
    const peakBins = [];
    const peakFreqs = [];
    const peakMags = [];
    const floor = maxMag * this.minPeakRatio;
    for (let k = 2; k < half - 1; k++) {
      const m = this.mag[k];
      if (
        m > floor &&
        m > this.mag[k - 1] &&
        m >= this.mag[k + 1] &&
        m > this.mag[k - 2] &&
        m > this.mag[k + 2]
      ) {
        const a = this.mag[k - 1];
        const c = this.mag[k + 1];
        const denom = a - 2 * m + c;
        const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
        peakBins.push(k);
        peakFreqs.push((k + shift) * binHz);
        peakMags.push(m);
      }
    }

    this.frameCount++;
    const payload = {
      type: 'frame',
      sampleRate: sr,
      fftSize: n,
      binHz,
      rms,
      frame: this.frameCount,
      audioTime: currentTime,
      peaks: {
        bin: peakBins,
        freq: peakFreqs,
        mag: peakMags,
      },
      // 频谱快照(下采样一半,减小跨线程体积)
      magnitude: this._downsampleMag(half),
    };
    this.port.postMessage(payload, [payload.magnitude.buffer]);
    return true;
  }

  _downsampleMag(half) {
    const step = 2;
    const out = new Float32Array(Math.ceil((half + 1) / step));
    for (let k = 0, j = 0; k <= half; k += step, j++) {
      out[j] = this.mag[k];
    }
    return out;
  }
}

registerProcessor('tuning-processor', TuningProcessor);
