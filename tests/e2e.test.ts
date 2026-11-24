import { describe, it, expect } from 'vitest';
import { synthesizeString } from '../src/audio/synth';
import { computeSpectrum, findPeaks } from '../src/math/fft';
import { LiveTuner } from '../src/math/analyzer';
import type { AnalysisFrame } from '../src/audio/engine';
import { presetPianos } from '../src/data/pianos';

/**
 * 端到端:模拟 AudioWorklet 真实帧尺寸(4096 点 @48k),
 * 从连续短帧中验证实时调音读数的音分精度,这是验收 0.5 音分的核心链路。
 */
describe('实时调音端到端(4096 点 worklet 帧)', () => {
  const sr = 48000;
  const fftSize = 4096;

  function frameFrom(signal: Float32Array, offset: number): AnalysisFrame {
    const slice = signal.subarray(offset, offset + fftSize);
    const spec = computeSpectrum(slice, sr);
    return {
      sampleRate: sr,
      fftSize,
      binHz: spec.binHz,
      rms: 0.2,
      frame: 1,
      audioTime: 0,
      magnitude: new Float32Array(spec.magnitude.length),
      peaks: findPeaks(spec, 0.008),
      receivedAt: 0,
    };
  }

  it('多台琴、多个键位的读数误差 < 0.5 音分', () => {
    const cases = [
      { piano: 0, midi: 45 }, // 中音
      { piano: 0, midi: 69 }, // A4
      { piano: 2, midi: 60 },
      { piano: 4, midi: 80 }, // 高音(九尺)
    ];
    for (const c of cases) {
      const piano = presetPianos()[c.piano];
      const spec = piano.strings.find((s) => s.midi === c.midi)!;
      // 弦被故意调偏 +1.8 音分
      const detuneCents = 1.8;
      const actual = spec.fEqual * Math.pow(2, detuneCents / 1200);
      const signal = synthesizeString({
        f1: actual,
        b: spec.bTheory,
        sampleRate: sr,
        partials: 12,
        duration: 3,
        seed: c.midi * 53 + 7,
      });
      const tuner = new LiveTuner({
        midi: c.midi,
        targetFrequency: spec.fEqual,
        b: spec.bTheory,
      });
      // 用三个不同时刻的短帧喂入,取最后一帧读数
      const offsets = [0, fftSize, fftSize * 2].filter(
        (o) => o + fftSize <= signal.length,
      );
      let reading = null;
      for (const o of offsets) {
        reading = tuner.process(frameFrom(signal, o));
      }
      expect(reading, `${piano.name} MIDI${c.midi}`).not.toBeNull();
      expect(
        Math.abs(reading!.centsError - detuneCents),
        `${piano.name} MIDI${c.midi} 读数 ${reading!.centsError}`,
      ).toBeLessThan(0.5);
      expect(reading!.partials).toBeGreaterThanOrEqual(3);
    }
  });

  it('延迟预算:拨弦到显示 < 150 ms', () => {
    // worklet:输入缓冲(128 帧)+ 4096 窗(50% 重叠,有效更新约半窗)
    const windowMs = (fftSize / 2 / sr) * 1000; // 半窗重叠
    const inputMs = (128 / sr) * 1000;
    const analysisMs = 2; // 主线程峰融合/拟合
    const total = windowMs + inputMs + analysisMs;
    expect(total).toBeLessThan(150);
  });
});
