/**
 * 声学/音高基础换算
 */

export const A4_MIDI = 69;
export const A4_FREQ = 440;
export const SEMITONES_PER_OCTAVE = 12;
export const CENTS_PER_SEMITONE = 100;

/** MIDI 键号 -> 平均律频率 */
export function midiToFreq(midi: number): number {
  return A4_FREQ * Math.pow(2, (midi - A4_MIDI) / SEMITONES_PER_OCTAVE);
}

/** 频率 -> MIDI 键号(浮点) */
export function freqToMidi(freq: number): number {
  return A4_MIDI + SEMITONES_PER_OCTAVE * Math.log2(freq / A4_FREQ);
}

/** 两个频率之比换算为音分 */
export function ratioToCents(fMeasured: number, fReference: number): number {
  return (
    CENTS_PER_SEMITONE *
    SEMITONES_PER_OCTAVE *
    Math.log2(fMeasured / fReference)
  );
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NAMES_CN = [
  'do',
  'do#',
  're',
  're#',
  'mi',
  'fa',
  'fa#',
  'sol',
  'sol#',
  'la',
  'la#',
  'si',
];

/** MIDI -> 音名,如 A4 */
export function midiToName(midi: number): string {
  const octave = Math.floor(midi / 12) - 1;
  return `${NAMES[midi % 12]}${octave}`;
}

/** MIDI -> 中文唱名,如 la4 */
export function midiToNameCn(midi: number): string {
  const octave = Math.floor(midi / 12) - 1;
  return `${NAMES_CN[midi % 12]}${octave}`;
}

/** 频率比的常用对数值(回归用) */
export function log2Safe(x: number): number {
  return Math.log2(x > 0 ? x : Number.EPSILON);
}
