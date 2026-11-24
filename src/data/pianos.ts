/**
 * 虚拟钢琴弦列生成
 *
 * 5 台虚构品牌、不同尺寸的钢琴(2 台立式 + 3 台三角)。
 * 弦长/线径/张力按物理关系反算保证自洽:
 *   f = (1/2L)·sqrt(T/μ)  =>  T = μ(2Lf)²
 * 缠弦质量 μ 由钢芯 + 铜绕组共同贡献,刚度由钢芯承担。
 */

import { PianoProfile, StringSpec } from '../types';
import { midiToFreq } from '../math/acoustics';
import { STEEL_DENSITY, STEEL_YOUNG, theoreticalB } from '../math/inharmonic';

const COPPER_DENSITY = 8960;

/** 确定性伪随机(固定种子,保证每次生成一致、可测试) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ScaleDesign {
  id: string;
  name: string;
  kind: string;
  /** 最低音 A0 有效弦长 m */
  bassLength: number;
  /** 缠/裸分界处(MIDI 52)弦长 m */
  breakLength: number;
  /** 最高音 C8 弦长 m */
  trebleLength: number;
  /** 最后一个缠弦键号 */
  lastWoundMidi: number;
  /** 张力调度两端 N */
  tensionWoundLow: number;
  tensionWoundHigh: number;
  tensionPlainHigh: number;
  tensionPlainTop: number;
  /** 缠弦钢芯直径端点 m */
  coreAtBass: number;
  coreAtBreak: number;
  /** 裸弦线径端点 m:裸弦区起点(较粗)→ 最高音(最细) */
  plainDiamAtBreak: number;
  plainDiamAtTop: number;
  seed: number;
  notes: string;
}

const DESIGNS: ScaleDesign[] = [
  {
    id: 'hong-sheng-u118',
    name: '鸿声 U-118 立式',
    kind: '118 cm 家用立式',
    bassLength: 1.12,
    breakLength: 0.36,
    trebleLength: 0.053,
    lastWoundMidi: 52,
    tensionWoundLow: 640,
    tensionWoundHigh: 780,
    tensionPlainHigh: 720,
    tensionPlainTop: 580,
    coreAtBass: 0.00145,
    coreAtBreak: 0.00105,
    plainDiamAtBreak: 0.001225,
    plainDiamAtTop: 0.000725,
    seed: 11801,
    notes: '教学/家用常见规格,弦短刚度影响显著,拉伸量偏大。',
  },
  {
    id: 'yun-song-u131',
    name: '韵松 UP-131 立式',
    kind: '131 cm 专业立式',
    bassLength: 1.28,
    breakLength: 0.4,
    trebleLength: 0.057,
    lastWoundMidi: 52,
    tensionWoundLow: 690,
    tensionWoundHigh: 820,
    tensionPlainHigh: 780,
    tensionPlainTop: 620,
    coreAtBass: 0.0015,
    coreAtBreak: 0.00108,
    plainDiamAtBreak: 0.00125,
    plainDiamAtTop: 0.000725,
    seed: 13102,
    notes: '高立式,弦列接近小三角,非谐性中等。',
  },
  {
    id: 'hai-yin-g168',
    name: '海音 G-168 三角',
    kind: '168 cm 客厅三角',
    bassLength: 1.72,
    breakLength: 0.46,
    trebleLength: 0.061,
    lastWoundMidi: 53,
    tensionWoundLow: 720,
    tensionWoundHigh: 860,
    tensionPlainHigh: 840,
    tensionPlainTop: 660,
    coreAtBass: 0.0015,
    coreAtBreak: 0.0011,
    plainDiamAtBreak: 0.001275,
    plainDiamAtTop: 0.00075,
    seed: 16803,
    notes: '交叉弦列,低音弦长明显增加,低音非谐性下降。',
  },
  {
    id: 'lie-ying-g186',
    name: '猎鹰 FG-186 三角',
    kind: '186 cm 演奏三角',
    bassLength: 2.02,
    breakLength: 0.52,
    trebleLength: 0.067,
    lastWoundMidi: 53,
    tensionWoundLow: 760,
    tensionWoundHigh: 900,
    tensionPlainHigh: 900,
    tensionPlainTop: 700,
    coreAtBass: 0.00155,
    coreAtBreak: 0.00112,
    plainDiamAtBreak: 0.0013,
    plainDiamAtTop: 0.00075,
    seed: 18604,
    notes: '音乐厅常备中型三角,中音区非谐性已很小。',
  },
  {
    id: 'tian-lai-c274',
    name: '天籁 CF-274 音乐会三角',
    kind: '274 cm 九尺音乐会三角',
    bassLength: 2.15,
    breakLength: 0.62,
    trebleLength: 0.077,
    lastWoundMidi: 54,
    tensionWoundLow: 800,
    tensionWoundHigh: 940,
    tensionPlainHigh: 980,
    tensionPlainTop: 740,
    coreAtBass: 0.0016,
    coreAtBreak: 0.00115,
    plainDiamAtBreak: 0.001325,
    plainDiamAtTop: 0.000775,
    seed: 27405,
    notes: '最长弦列,整体非谐性最低,拉伸曲线最平缓。',
  },
];

function unisonCount(midi: number): number {
  if (midi <= 33) return 1; // 单弦组
  if (midi <= 47) return 2; // 双弦组
  return 3; // 三弦组
}

function buildStringSpec(design: ScaleDesign, midi: number, rnd: () => number): StringSpec {
  const f = midiToFreq(midi);
  const wound = midi <= design.lastWoundMidi;

  let length: number;
  let tension: number;
  let diameter: number;
  let windingDiameter = 0;

  if (wound) {
    // 缠弦:弦长对数插值,张力平滑调度,再反算铜绕组
    const t = (midi - 21) / (design.lastWoundMidi - 21);
    length =
      design.bassLength *
      (design.breakLength / design.bassLength) ** t;
    length *= 1 + (rnd() - 0.5) * 0.012;
    tension =
      design.tensionWoundLow +
      (design.tensionWoundHigh - design.tensionWoundLow) * t;

    const muTarget = tension / (2 * length * f) ** 2;
    let core =
      design.coreAtBreak +
      (design.coreAtBass - design.coreAtBreak) * (1 - t);
    const rhoS = STEEL_DENSITY;
    let outerSq =
      (4 * muTarget) / Math.PI / COPPER_DENSITY -
      ((rhoS - COPPER_DENSITY) / COPPER_DENSITY) * core * core;
    let guard = 0;
    while (outerSq <= core * core && guard < 8) {
      core *= 0.97;
      outerSq =
        (4 * muTarget) / Math.PI / COPPER_DENSITY -
        ((rhoS - COPPER_DENSITY) / COPPER_DENSITY) * core * core;
      guard++;
    }
    const outer = Math.sqrt(Math.max(outerSq, core * core));
    windingDiameter = Math.max(0, (outer - core) / 2);
    diameter = core;
  } else {
    // 裸弦:先定线规与目标张力,由 T = μ(2Lf)² 反推物理自洽弦长。
    // 线径、张力、弦长三者严格满足弦振动方程,B 因而物理可信。
    const t =
      (midi - design.lastWoundMidi) / (108 - design.lastWoundMidi);
    diameter =
      design.plainDiamAtBreak +
      (design.plainDiamAtTop - design.plainDiamAtBreak) * t ** 1.12;
    diameter *= 1 + (rnd() - 0.5) * 0.006;
    tension =
      design.tensionPlainHigh +
      (design.tensionPlainTop - design.tensionPlainHigh) * t ** 1.5;
    const mu = (STEEL_DENSITY * Math.PI * diameter * diameter) / 4;
    length = Math.sqrt(tension / mu) / (2 * f);
  }

  const bTheory = theoreticalB(length, diameter, tension);

  return {
    midi,
    fEqual: f,
    length,
    diameter,
    tension,
    unisons: unisonCount(midi),
    wound,
    windingDiameter,
    bTheory,
  };
}

function buildProfile(design: ScaleDesign): PianoProfile {
  const rnd = mulberry32(design.seed);
  const strings: StringSpec[] = [];
  for (let midi = 21; midi <= 108; midi++) {
    strings.push(buildStringSpec(design, midi, rnd));
  }
  return {
    id: design.id,
    name: design.name,
    kind: design.kind,
    strings,
    createdAt: new Date(2026, 10, 1).toISOString(),
    notes: design.notes,
  };
}

export const PRESET_DESIGNS = DESIGNS;

let cache: PianoProfile[] | null = null;

/** 5 台预置钢琴(进程内缓存) */
export function presetPianos(): PianoProfile[] {
  if (!cache) cache = DESIGNS.map(buildProfile);
  return cache;
}

export function presetById(id: string): PianoProfile | undefined {
  return presetPianos().find((p) => p.id === id);
}

/**
 * Railsback 公开统计曲线参考锚点(音分,相对平均律)。
 * 数据取常见出版物中 Railsback 平均曲线的读图值,线性插值展示。
 */
export const RAILSBACK_ANCHORS: { midi: number; cents: number }[] = [
  { midi: 21, cents: -32 },
  { midi: 24, cents: -26 },
  { midi: 28, cents: -21 },
  { midi: 32, cents: -16 },
  { midi: 36, cents: -12 },
  { midi: 40, cents: -8.5 },
  { midi: 44, cents: -6 },
  { midi: 48, cents: -4 },
  { midi: 52, cents: -2.5 },
  { midi: 56, cents: -1.5 },
  { midi: 60, cents: -0.8 },
  { midi: 64, cents: 0 },
  { midi: 69, cents: 0 },
  { midi: 72, cents: 1.2 },
  { midi: 76, cents: 2.6 },
  { midi: 80, cents: 4.5 },
  { midi: 84, cents: 7.5 },
  { midi: 88, cents: 11 },
  { midi: 92, cents: 15 },
  { midi: 96, cents: 19.5 },
  { midi: 100, cents: 23.5 },
  { midi: 104, cents: 27 },
  { midi: 108, cents: 31 },
];

/** Railsback 参考值(线性插值,音分) */
export function railsbackCents(midi: number): number {
  const a = RAILSBACK_ANCHORS;
  if (midi <= a[0].midi) return a[0].cents;
  for (let i = 0; i < a.length - 1; i++) {
    if (midi >= a[i].midi && midi <= a[i + 1].midi) {
      const t = (midi - a[i].midi) / (a[i + 1].midi - a[i].midi);
      return a[i].cents + t * (a[i + 1].cents - a[i].cents);
    }
  }
  return a[a.length - 1].cents;
}

/** 材料常量导出供档案页展示 */
export { STEEL_YOUNG };
