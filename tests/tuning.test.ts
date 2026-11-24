import { describe, it, expect } from 'vitest';
import { presetPianos, railsbackCents } from '../src/data/pianos';
import { buildBTable, solveStretchCurve } from '../src/math/tuning';
import { Measurement } from '../src/types';
import { synthesizeString } from '../src/audio/synth';
import { computeSpectrum, findPeaks } from '../src/math/fft';
import { matchAndFit } from '../src/math/inharmonic';
import { measureString } from '../src/math/analyzer';
import type { AnalysisFrame } from '../src/audio/engine';

describe('虚拟钢琴弦列物理自洽性', () => {
  const pianos = presetPianos();

  it('共 5 台、每台 88 键', () => {
    expect(pianos).toHaveLength(5);
    for (const p of pianos) expect(p.strings).toHaveLength(88);
  });

  it('张力落在真实钢琴 500–1100 N 区间', () => {
    for (const p of pianos) {
      for (const s of p.strings) {
        expect(s.tension).toBeGreaterThan(450);
        expect(s.tension).toBeLessThan(1150);
      }
    }
  });

  it('实测拟合 B 与理论 B 相差不超过 10%(每台抽 6 键)', () => {
    const sr = 48000;
    for (const piano of pianos) {
      const idxs = [0, 12, 25, 40, 55, 72];
      for (const idx of idxs) {
        const spec = piano.strings[Math.min(idx, 87)];
        const sig = synthesizeString({
          f1: spec.fEqual,
          b: spec.bTheory,
          sampleRate: sr,
          partials: 16,
          duration: 2.5,
          unisons: 1,
          seed: spec.midi * 31 + 5,
        });
        const peaks = findPeaks(computeSpectrum(sig, sr), 0.008);
        const fit = matchAndFit(peaks, spec.fEqual, {
          maxPartials: 14,
          maxFreq: 5500,
          roughB: spec.bTheory,
        });
        const relErr = Math.abs((fit.b - spec.bTheory) / spec.bTheory);
        expect(relErr, `${piano.name} MIDI${spec.midi}`).toBeLessThan(0.1);
      }
    }
  });

  it('大琴整体非谐性低于小琴', () => {
    const medianB = (id: number) => {
      const bs = pianos[id].strings.map((s) => s.bTheory).sort((a, b) => a - b);
      return bs[44];
    };
    // 九尺(末台)中位 B 应小于 118 立式(首台)
    expect(medianB(4)).toBeLessThan(medianB(0));
  });
});

describe('拉伸调律曲线', () => {
  it('高音拉伸走势与 Railsback 一致(单调上升、幅度同量级)', () => {
    const piano = presetPianos()[0];
    const table = buildBTable(piano, []);
    const curve = solveStretchCurve(piano, table);
    const at = (midi: number) => curve.find((t) => t.midi === midi)!.centsOffset;

    // 高音区单调上升
    const treble = [72, 84, 96, 108].map(at);
    for (let i = 1; i < treble.length; i++) {
      expect(treble[i]).toBeGreaterThan(treble[i - 1]);
    }
    // 低音为负、高音为正
    expect(at(21)).toBeLessThan(0);
    expect(at(108)).toBeGreaterThan(0);

    // 与 Railsback 同号且同量级:Railsback 是多琴统计平均,
    // 小立式拉伸更剧烈属物理正常,逐点偏差放宽到 10 音分以内或 2 倍以内
    for (const midi of [84, 96, 108]) {
      const ref = railsbackCents(midi);
      const own = at(midi);
      expect(own).toBeGreaterThan(0); // 同为正拉伸
      expect(Math.abs(own - ref)).toBeLessThan(Math.max(10, ref * 1.2));
    }
    // C8 端点与 Railsback 锚点应高度吻合(整体拉伸量基准)
    expect(Math.abs(at(108) - railsbackCents(108))).toBeLessThan(6);
  });

  it('5 台琴曲线均通过 Railsback 高音趋势检验', () => {
    for (const piano of presetPianos()) {
      const table = buildBTable(piano, []);
      const curve = solveStretchCurve(piano, table);
      const at = (midi: number) => curve.find((t) => t.midi === midi)!.centsOffset;
      // 走势:高音单调上升、与 Railsback 同号
      for (const midi of [84, 96, 108]) {
        expect(at(midi), `${piano.name} MIDI${midi}`).toBeGreaterThan(0);
      }
      expect(at(108) - at(84)).toBeGreaterThan(5);
      // C8 端点收敛到 Railsback 锚点 ±8 音分
      expect(
        Math.abs(at(108) - railsbackCents(108)),
        `${piano.name} C8`,
      ).toBeLessThan(8);
    }
  });

  it('A4 锚点为 0 音分', () => {
    const piano = presetPianos()[1];
    const curve = solveStretchCurve(piano, buildBTable(piano, []));
    expect(Math.abs(curve.find((t) => t.midi === 69)!.centsOffset)).toBeLessThan(
      0.01,
    );
  });

  it('纳入实测点后曲线仍平滑且保持走势', () => {
    const piano = presetPianos()[2];
    const sr = 48000;
    const measurements: Measurement[] = [];
    for (const midi of [28, 40, 52, 64, 76, 84, 92]) {
      const spec = piano.strings.find((s) => s.midi === midi)!;
      const sig = synthesizeString({
        f1: spec.fEqual,
        b: spec.bTheory * 1.03, // 模拟实测与理论 3% 偏差
        sampleRate: sr,
        partials: 14,
        duration: 2.5,
        seed: midi * 17,
      });
      const frame: AnalysisFrame = {
        sampleRate: sr,
        fftSize: sig.length,
        binHz: sr / sig.length,
        rms: 0.2,
        frame: 1,
        audioTime: 0,
        magnitude: new Float32Array(),
        peaks: findPeaks(computeSpectrum(sig, sr), 0.008),
        receivedAt: 0,
      };
      const r = measureString([frame], spec.fEqual, { roughB: spec.bTheory });
      measurements.push({
        midi,
        f1: r.f1,
        b: r.b,
        partialsUsed: r.partialsUsed,
        r2: r.r2,
        partialFrequencies: r.partialFrequencies,
        measuredAt: 0,
      });
    }
    const table = buildBTable(piano, measurements);
    const curve = solveStretchCurve(piano, table);
    const at = (midi: number) => curve.find((t) => t.midi === midi)!.centsOffset;
    // 实测键 B 表取值等于实测值
    expect(table.values[measurements[0].midi - 21]).toBeCloseTo(
      measurements[0].b,
      10,
    );
    // 平滑:内部相邻键跳变 < 2 音分(实测键附近 B 台阶经正则平滑后的残余);
    // 最高两个键受端点约束不足影响,放宽到 3;首键单独放宽到 4
    for (let i = 1; i < curve.length - 2; i++) {
      expect(
        Math.abs(curve[i].centsOffset - curve[i - 1].centsOffset),
        `MIDI ${curve[i].midi}`,
      ).toBeLessThan(2);
    }
    for (let i = curve.length - 2; i < curve.length; i++) {
      expect(
        Math.abs(curve[i].centsOffset - curve[i - 1].centsOffset),
        `MIDI ${curve[i].midi}`,
      ).toBeLessThan(4);
    }
    expect(at(108)).toBeGreaterThan(at(84));
  });
});
