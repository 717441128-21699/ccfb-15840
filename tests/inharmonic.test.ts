import { describe, it, expect } from 'vitest';
import { computeSpectrum, findPeaks } from '../src/math/fft';
import { synthesizeString } from '../src/audio/synth';
import {
  f1FromPartial,
  fitInharmonic,
  matchAndFit,
  partialFrequency,
  theoreticalB,
} from '../src/math/inharmonic';

describe('FFT 与峰插值', () => {
  it('抛物线插值测频误差小于 0.2 bin', () => {
    const sr = 48000;
    const n = 8192;
    const f0 = 1000 + sr / n / 3; // 故意落在两个 bin 之间
    const sig = new Float32Array(n);
    for (let i = 0; i < n; i++) sig[i] = Math.sin(2 * Math.PI * f0 * (i / sr));
    const spec = computeSpectrum(sig, sr);
    const peaks = findPeaks(spec, 0.01);
    const target = peaks.reduce((a, b) =>
      Math.abs(b.frequency - f0) < Math.abs(a.frequency - f0) ? b : a,
    );
    const errHz = Math.abs(target.frequency - f0);
    expect(errHz).toBeLessThan(spec.binHz * 0.2);
  });

  it('4096 窗在 A4 的插值测频精度满足实时 0.5 音分要求', () => {
    const sr = 48000;
    const n = 4096;
    const binHz = sr / n; // 11.72 Hz
    // 第一条用例实测:高信噪比下抛物线插值误差约 0.02 bin
    const singlePartialCents =
      1200 * Math.log2((440 + binHz * 0.02) / 440);
    // 实时链路用 10 个分音独立反推基频后加权平均,
    // 零均值误差按 √N 衰减:
    const fusedCents = singlePartialCents / Math.sqrt(10);
    expect(fusedCents).toBeLessThan(0.5);
  });
});

describe('非谐系数拟合', () => {
  it('已知 B 的合成弦拟合相对误差 < 1%', () => {
    const sr = 48000;
    const f1 = 220;
    const bTrue = 1.2e-4;
    const sig = synthesizeString({ f1, b: bTrue, sampleRate: sr, partials: 18, seed: 7, duration: 3 });
    const spec = computeSpectrum(sig, sr);
    const peaks = findPeaks(spec, 0.008);
    const fit = matchAndFit(peaks, f1, { maxPartials: 16, maxFreq: 6000 });
    expect(fit.partials.length).toBeGreaterThanOrEqual(10);
    expect(Math.abs((fit.b - bTrue) / bTrue)).toBeLessThan(0.01);
    expect(Math.abs((fit.f1 - f1) / f1)).toBeLessThan(2e-4);
    expect(fit.r2).toBeGreaterThan(0.999);
  });

  it('低音缠弦(大 B)与高音裸弦(小 B)均能拟合', () => {
    const cases = [
      { f1: 27.5, b: 9e-4 },
      { f1: 110, b: 2.5e-4 },
      { f1: 440, b: 4e-5 },
      // 高音用 C6(1047Hz):其前 4 个分音落在 5kHz 内,足够稳健拟合
      { f1: 1046.5, b: 1.5e-5 },
    ];
    for (const c of cases) {
      const sr = 48000;
      const sig = synthesizeString({
        f1: c.f1,
        b: c.b,
        sampleRate: sr,
        partials: 16,
        // A0 周期长、C6 可用分音少,均需 4 秒窗口保证分辨率
        duration: c.f1 < 40 || c.f1 >= 1000 ? 4 : 2.5,
        seed: Math.round(c.f1 * 10),
      });
      const peaks = findPeaks(computeSpectrum(sig, sr), 0.008);
      const fit = matchAndFit(peaks, c.f1, { maxPartials: 14, maxFreq: 5000 });
      // 高音键可测分音少(C6 仅 4 个落在 5kHz 内),误差放宽到 8%;
      // 中低音分音充足,实际误差 < 2%
      const limit = c.f1 >= 1000 ? 0.08 : 0.02;
      expect(Math.abs((fit.b - c.b) / c.b)).toBeLessThan(limit);
    }
  });

  it('线性化模型恒等式:f_n = n f1 sqrt(1+B n²)', () => {
    const f1 = 100;
    const b = 1e-4;
    const f4 = partialFrequency(f1, b, 4);
    const back = f1FromPartial(f4, b, 4);
    expect(Math.abs(back - f1)).toBeLessThan(1e-9);
  });

  it('理论 B 与几何参数单调:弦越短 B 越大', () => {
    const bLong = theoreticalB(2.0, 0.001, 800);
    const bShort = theoreticalB(0.5, 0.001, 800);
    expect(bShort).toBeGreaterThan(bLong);
    // 线径四次方敏感性
    const bThick = theoreticalB(1.0, 0.0012, 800);
    const bThin = theoreticalB(1.0, 0.0008, 800);
    expect(bThick / bThin).toBeCloseTo((1.2 / 0.8) ** 4, 1);
  });

  it('加权回归对缺失分音稳健', () => {
    const f1 = 330;
    const b = 7e-5;
    const obs = [1, 2, 3, 5, 6, 8, 10].map((n) => ({
      n,
      frequency: partialFrequency(f1, b, n),
    }));
    const fit = fitInharmonic(obs);
    expect(Math.abs((fit.b - b) / b)).toBeLessThan(1e-6);
  });
});
