import { describe, it, expect } from 'vitest';
/**
 * 完整业务流程冒烟测试:模拟真实调律师工作流
 * 选琴 → 多键测弦 → B 表拟合 → 拉伸曲线 → 逐键调音 → 三弦拍频
 */
import { presetPianos, railsbackCents } from '../src/data/pianos';
import { synthesizeString } from '../src/audio/synth';
import { computeSpectrum, findPeaks } from '../src/math/fft';
import { measureString } from '../src/math/analyzer';
import { buildBTable, solveStretchCurve } from '../src/math/tuning';
import { LiveTuner } from '../src/math/analyzer';
import { detectUnisons } from '../src/math/beats';
import type { AnalysisFrame } from '../src/audio/engine';
import type { Measurement } from '../src/types';

describe('完整调律工作流', () => {
  it('从测弦到逐键调音全链路通过验收', () => {
  const sr = 48000;
  const piano = presetPianos()[0]; // 118 立式

// 1. 测 8 个键
const measured: Measurement[] = [];
for (const midi of [24, 33, 45, 52, 60, 69, 80, 92]) {
  const spec = piano.strings.find((s) => s.midi === midi)!;
  const sig = synthesizeString({
    f1: spec.fEqual,
    b: spec.bTheory * 1.02, // 2% 真实偏差
    sampleRate: sr,
    partials: 14,
    duration: 3,
    seed: midi * 31,
  });
  const frame: AnalysisFrame = {
    sampleRate: sr, fftSize: sig.length, binHz: sr / sig.length,
    rms: 0.2, frame: 1, audioTime: 0,
    magnitude: new Float32Array(),
    peaks: findPeaks(computeSpectrum(sig, sr), 0.008),
    receivedAt: 0,
  };
  const r = measureString([frame], spec.fEqual, { roughB: spec.bTheory });
  measured.push({
    midi, f1: r.f1, b: r.b, partialsUsed: r.partialsUsed, r2: r.r2,
    partialFrequencies: r.partialFrequencies, measuredAt: 0,
  });
}

// 2. B 拟合精度验收(±10%)
let maxBErr = 0;
for (const m of measured) {
  const spec = piano.strings.find((s) => s.midi === m.midi)!;
  maxBErr = Math.max(maxBErr, Math.abs((m.b - spec.bTheory) / spec.bTheory));
}
console.log(`测弦 ${measured.length} 键 | 最大 B 偏差 ${(maxBErr * 100).toFixed(2)}% (验收 ≤10%)`);

// 3. 整琴 B 表 + 拉伸曲线
const table = buildBTable(piano, measured);
const curve = solveStretchCurve(piano, table);
const at = (m: number) => curve.find((t) => t.midi === m)!.centsOffset;
console.log(`拉伸曲线 A0=${at(21).toFixed(1)}¢ A4=${at(69).toFixed(1)}¢ C8=${at(108).toFixed(1)}¢`);
console.log(`Railsback 对照 C8=${railsbackCents(108)}¢ | 走势 ${at(96) < at(108) ? '单调上升 ✓' : '✗'}`);

// 4. 逐键调音:弦偏离目标 +3 音分,验证读数
const target69 = curve.find((t) => t.midi === 69)!;
const actual = target69.frequency * 2 ** (3 / 1200);
const tuneSig = synthesizeString({
  f1: actual, b: table.values[69 - 21], sampleRate: sr,
  partials: 12, duration: 3, seed: 6901,
});
const tuner = new LiveTuner({
  midi: 69, targetFrequency: target69.frequency, b: table.values[69 - 21],
});
const tuneFrame: AnalysisFrame = {
  sampleRate: sr, fftSize: tuneSig.length, binHz: sr / tuneSig.length,
  rms: 0.2, frame: 1, audioTime: 0, magnitude: new Float32Array(),
  peaks: findPeaks(computeSpectrum(tuneSig, sr), 0.008), receivedAt: 0,
};
const reading = tuner.process(tuneFrame)!;
console.log(`调音读数:真实 +3.00¢,测得 ${reading.centsError.toFixed(2)}¢ (验收误差 <0.5¢)`);

// 5. 三弦拍频
const unisonSig = synthesizeString({
  f1: target69.frequency, b: table.values[69 - 21], sampleRate: sr,
  unisons: 3, unisonDetuneCents: [-2, 0, 2], partials: 12, duration: 3, seed: 6902,
});
const unisonFrame: AnalysisFrame = {
  sampleRate: sr, fftSize: unisonSig.length, binHz: sr / unisonSig.length,
  rms: 0.2, frame: 1, audioTime: 0, magnitude: new Float32Array(),
  peaks: findPeaks(computeSpectrum(unisonSig, sr), 0.008), receivedAt: 0,
};
const beats = detectUnisons(unisonFrame.peaks, target69.frequency, table.values[69 - 21]);
console.log(`三弦分辨:${beats.stringFrequencies.length} 根弦,拍频 ${beats.beatRates.map((r) => r.toFixed(2) + 'Hz').join(', ')}`);

// 汇总验收
  expect(maxBErr).toBeLessThan(0.1);
  expect(Math.abs(reading.centsError - 3)).toBeLessThan(0.5);
  expect(beats.stringFrequencies.length).toBe(3);
  expect(at(96)).toBeLessThan(at(108));
  expect(Math.abs(at(108) - railsbackCents(108))).toBeLessThan(8);
  expect(at(21)).toBeLessThan(0);
  });
});
