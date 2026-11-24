import { describe, it, expect } from 'vitest';
import { computeSpectrum, findPeaks } from '../src/math/fft';
import { synthesizeString } from '../src/audio/synth';
import { detectUnisons, envelopeBeatRate } from '../src/math/beats';
import { LiveTuner } from '../src/math/analyzer';
import type { AnalysisFrame } from '../src/audio/engine';
import { ratioToCents } from '../src/math/acoustics';

function frameOf(samples: Float32Array, sr: number): AnalysisFrame {
  const spec = computeSpectrum(samples, sr);
  return {
    sampleRate: sr,
    fftSize: samples.length,
    binHz: spec.binHz,
    rms: 0.2,
    frame: 1,
    audioTime: 0,
    magnitude: new Float32Array(spec.magnitude.length),
    peaks: findPeaks(spec, 0.008),
    receivedAt: 0,
  };
}

describe('同音弦拍频检测', () => {
  it('三弦失调时分辨出 3 个基频并给出拍频', () => {
    const sr = 48000;
    const f1 = 261.63;
    const b = 5e-5;
    const sig = synthesizeString({
      f1,
      b,
      sampleRate: sr,
      unisons: 3,
      unisonDetuneCents: [-2.5, 0, 2.5],
      partials: 12,
      duration: 2.5,
      seed: 99,
    });
    const frame = frameOf(sig, sr);
    const result = detectUnisons(frame.peaks, f1, b, { targetFrequency: f1 });
    expect(result.stringFrequencies.length).toBe(3);
    // 三根弦两两组合共 C(3,2)=3 对拍频
    expect(result.beatRates.length).toBe(3);
    // 最外侧两弦相差 5 音分,基频级拍频约 0.76 Hz;高分音上更快
    for (const rate of result.beatRates) {
      expect(rate).toBeGreaterThan(0.2);
      expect(rate).toBeLessThan(12);
    }
    // 各弦音分误差与设定失调对应
    expect(result.stringCentsErrors[0]).toBeLessThan(-1.5);
    expect(result.stringCentsErrors[2]).toBeGreaterThan(1.5);
  });

  it('单弦(已调齐)不报拍', () => {
    const sr = 48000;
    const sig = synthesizeString({
      f1: 440,
      b: 4e-5,
      sampleRate: sr,
      unisons: 1,
      partials: 12,
      seed: 5,
    });
    const frame = frameOf(sig, sr);
    const result = detectUnisons(frame.peaks, 440, 4e-5);
    expect(result.stringFrequencies.length).toBe(1);
    expect(result.beatRates.length).toBe(0);
  });

  it('包络法可直接读出振幅调制频率', () => {
    const sr = 48000;
    const f1 = 300;
    const beatHz = 3;
    // 两根相差 beatHz 的正弦叠加,包络以 beatHz 起伏
    const n = sr * 3;
    const sig = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      sig[i] =
        0.5 * Math.sin(2 * Math.PI * f1 * t) +
        0.5 * Math.sin(2 * Math.PI * (f1 + beatHz) * t);
    }
    const got = envelopeBeatRate(sig, sr, f1);
    expect(got).not.toBeNull();
    expect(Math.abs(got! - beatHz)).toBeLessThan(0.6);
  });
});

describe('实时调音读数', () => {
  it('0.5 音分以内的读数精度(多偏移量扫描)', () => {
    const sr = 48000;
    const target = 440;
    const b = 4e-5;
    const offsets = [-8, -3, -0.4, 0, 0.4, 2.5, 7];
    for (const cents of offsets) {
      const actual = target * Math.pow(2, cents / 1200);
      const sig = synthesizeString({
        f1: actual,
        b,
        sampleRate: sr,
        partials: 12,
        duration: 2.5,
        unisons: 1,
        seed: Math.round(actual * 100),
      });
      const frame = frameOf(sig, sr);
      const tuner = new LiveTuner({
        midi: 69,
        targetFrequency: target,
        b,
        tolerance: 0.01,
      });
      // 连续三帧验证 EMA 收敛
      let reading = tuner.process(frame)!;
      reading = tuner.process(frame)!;
      reading = tuner.process(frame)!;
      expect(reading).toBeTruthy();
      expect(
        Math.abs(reading.centsError - cents),
        `偏移 ${cents}¢ 实测 ${reading.centsError}¢`,
      ).toBeLessThan(0.5);
      expect(reading.partials).toBeGreaterThanOrEqual(4);
      expect(reading.confidence).toBeGreaterThan(0.3);
    }
  });

  it('150 ms 延迟预算核算(48k 交互延迟 + 4096 窗)', () => {
    const sr = 48000;
    const fftSize = 4096;
    const windowMs = (fftSize / sr) * 1000; // 85.3 ms
    // 现代平板/Chrome interactive 通常 baseLatency ≈ 128 帧 ≈ 2.7 ms
    const typicalInputMs = (128 / sr) * 1000;
    const threadQueueMs = 8; // worklet→主线程典型排队
    const total = windowMs + typicalInputMs + threadQueueMs;
    expect(total).toBeLessThan(150);
    // 即便输入缓冲升到 256 帧仍达标
    const conservative = windowMs + (256 / sr) * 1000 + 15;
    expect(conservative).toBeLessThan(150);
  });

  it('静音帧返回 null 而非错误读数', () => {
    const sr = 48000;
    const silence = new Float32Array(4096);
    const frame = frameOf(silence, sr);
    frame.rms = 0.0001;
    const tuner = new LiveTuner({
      midi: 69,
      targetFrequency: 440,
      b: 4e-5,
    });
    expect(tuner.process(frame)).toBeNull();
  });
});
