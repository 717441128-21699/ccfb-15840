/**
 * 全局领域类型定义
 */

/** 单根弦(一个键的一组同音弦共用一组物理参数) */
export interface StringSpec {
  /** MIDI 键号 21..108 */
  midi: number;
  /** 平均律基频 Hz */
  fEqual: number;
  /** 有效弦长 m */
  length: number;
  /** 裸钢丝线径(缠弦为芯线直径) m */
  diameter: number;
  /** 总张力 N */
  tension: number;
  /** 同音弦(单弦组 / 双弦组 / 三弦组)数量 */
  unisons: number;
  /** 是否缠弦 */
  wound: boolean;
  /** 缠弦外层铜丝直径 m,裸弦为 0 */
  windingDiameter: number;
  /** 理论非谐系数 B(由几何与材料参数算出) */
  bTheory: number;
}

/** 一整台琴 88 键的弦列 */
export interface PianoProfile {
  id: string;
  name: string;
  /** 形制简述,如 九尺音乐会三角 */
  kind: string;
  /** 弦列参数表,按 midi 升序,长度 88 */
  strings: StringSpec[];
  /** 出厂/建档日期 ISO 字符串 */
  createdAt: string;
  notes?: string;
}

/** 测弦结果:对某键录一次音得到的拟合结果 */
export interface Measurement {
  midi: number;
  /** 拟合出的基频 Hz(刚性修正后的第 1 分音) */
  f1: number;
  /** 拟合出的非谐系数 B,满足 f_n = n f1 sqrt(1 + B n²) */
  b: number;
  /** 参与拟合的分音数 */
  partialsUsed: number;
  /** 线性化回归的决定系数 R² */
  r2: number;
  /** 各分音的实测频率 Hz */
  partialFrequencies: number[];
  /** 测量时间戳 */
  measuredAt: number;
}

/** 调律曲线中每个键的目标值 */
export interface TuningTarget {
  midi: number;
  /** 目标基频(已含拉伸) Hz */
  frequency: number;
  /** 相对平均律的偏离,单位音分(正=偏高) */
  centsOffset: number;
}

/** 实时调音读数 */
export interface TunerReading {
  midi: number;
  /** 当前基频估计 Hz */
  fundamental: number;
  /** 相对该键拉伸目标的偏差,音分 */
  centsError: number;
  /** 参与加权的分音数 */
  partials: number;
  /** 置信度 0..1(基于峰能量与一致性) */
  confidence: number;
}

/** 同音弦拍频分析结果 */
export interface BeatResult {
  /** 检测到的拍频 Hz,空数组表示未检出多弦拍 */
  beatRates: number[];
  /** 由聚类分音峰反推的各弦基频 Hz(1..3 个) */
  stringFrequencies: number[];
  /** 各弦相对目标的偏差,音分 */
  stringCentsErrors: number[];
}
