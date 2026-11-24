/**
 * 应用状态:当前档案、实测数据、调律目标、设置
 * 持久化到 localStorage,并提供 JSON 导入导出。
 */

import { Measurement, PianoProfile, TuningTarget } from '../types';
import { presetPianos } from '../data/pianos';
import { buildBTable, solveStretchCurve, type BTable } from '../math/tuning';

const STORAGE_KEY = 'piano-tuner-state-v1';

export interface AppSettings {
  demoMode: boolean;
  a4Reference: number;
  anchorMidi: number;
}

interface PersistShape {
  selectedPianoId: string | null;
  measurements: Record<string, Measurement[]>;
  customPianos: PianoProfile[];
  settings: AppSettings;
  tuningProgress: Record<string, Record<number, number>>;
}

type Listener = () => void;

class Store {
  selectedPianoId: string | null = null;
  measurements = new Map<string, Measurement[]>();
  customPianos: PianoProfile[] = [];
  settings: AppSettings = {
    demoMode: true,
    a4Reference: 440,
    anchorMidi: 69,
  };
  /** 调律进度:profileId -> midi -> 最近一次音分偏差 */
  tuningProgress = new Map<string, Map<number, number>>();

  private bCache = new Map<string, BTable>();
  private targetCache = new Map<string, TuningTarget[]>();
  private listeners = new Set<Listener>();

  constructor() {
    this.load();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
    this.save();
  }

  allPianos(): PianoProfile[] {
    return [...presetPianos(), ...this.customPianos];
  }

  currentPiano(): PianoProfile | undefined {
    if (!this.selectedPianoId) return undefined;
    return this.allPianos().find((p) => p.id === this.selectedPianoId);
  }

  selectPiano(id: string): void {
    this.selectedPianoId = id;
    this.emit();
  }

  addCustomPiano(profile: PianoProfile): void {
    this.customPianos = this.customPianos.filter((p) => p.id !== profile.id);
    this.customPianos.push(profile);
    this.emit();
  }

  addMeasurement(m: Measurement): void {
    if (!this.selectedPianoId) return;
    const list = this.measurements.get(this.selectedPianoId) ?? [];
    // 同键去重:保留最新,但最多保留 3 次历史
    const filtered = list.filter((x) => x.midi !== m.midi);
    filtered.push(m);
    filtered.sort((a, b) => a.midi - b.midi);
    this.measurements.set(this.selectedPianoId, filtered);
    this.bCache.delete(this.selectedPianoId);
    this.targetCache.delete(this.selectedPianoId);
    this.emit();
  }

  removeMeasurement(midi: number): void {
    if (!this.selectedPianoId) return;
    const list = this.measurements.get(this.selectedPianoId);
    if (!list) return;
    this.measurements.set(
      this.selectedPianoId,
      list.filter((m) => m.midi !== midi),
    );
    this.bCache.delete(this.selectedPianoId);
    this.targetCache.delete(this.selectedPianoId);
    this.emit();
  }

  currentMeasurements(): Measurement[] {
    if (!this.selectedPianoId) return [];
    return this.measurements.get(this.selectedPianoId) ?? [];
  }

  bTable(): BTable | null {
    const piano = this.currentPiano();
    if (!piano) return null;
    const cached = this.bCache.get(piano.id);
    if (cached) return cached;
    const table = buildBTable(piano, this.currentMeasurements());
    this.bCache.set(piano.id, table);
    return table;
  }

  tuningTargets(): TuningTarget[] {
    const piano = this.currentPiano();
    if (!piano) return [];
    const cached = this.targetCache.get(piano.id);
    if (cached) return cached;
    const table = this.bTable();
    if (!table) return [];
    const targets = solveStretchCurve(piano, table, this.settings.anchorMidi);
    this.targetCache.set(piano.id, targets);
    return targets;
  }

  targetFor(midi: number): TuningTarget | undefined {
    return this.tuningTargets().find((t) => t.midi === midi);
  }

  bFor(midi: number): number | null {
    const table = this.bTable();
    const piano = this.currentPiano();
    if (!table || !piano) return null;
    const idx = midi - piano.strings[0].midi;
    return table.values[idx] ?? null;
  }

  recordTuningProgress(midi: number, centsError: number): void {
    if (!this.selectedPianoId) return;
    const id = this.selectedPianoId;
    if (!this.tuningProgress.has(id)) {
      this.tuningProgress.set(id, new Map());
    }
    this.tuningProgress.get(id)!.set(midi, centsError);
    this.save();
  }

  updateSettings(patch: Partial<AppSettings>): void {
    this.settings = { ...this.settings, ...patch };
    this.emit();
  }

  exportJSON(): string {
    const data: PersistShape = {
      selectedPianoId: this.selectedPianoId,
      measurements: Object.fromEntries(this.measurements),
      customPianos: this.customPianos,
      settings: this.settings,
      tuningProgress: Object.fromEntries(
        Array.from(this.tuningProgress.entries()).map(([k, v]) => [
          k,
          Object.fromEntries(v),
        ]),
      ),
    };
    return JSON.stringify(data, null, 2);
  }

  importJSON(text: string): void {
    const data = JSON.parse(text) as PersistShape;
    this.selectedPianoId = data.selectedPianoId;
    this.measurements = new Map(Object.entries(data.measurements ?? {}));
    this.customPianos = data.customPianos ?? [];
    this.settings = { ...this.settings, ...(data.settings ?? {}) };
    this.tuningProgress = new Map(
      Object.entries(data.tuningProgress ?? {}).map(([k, v]) => [
        k,
        new Map(Object.entries(v).map(([m, c]) => [Number(m), c])),
      ]),
    );
    this.bCache.clear();
    this.targetCache.clear();
    this.emit();
  }

  private save(): void {
    try {
      const data: PersistShape = {
        selectedPianoId: this.selectedPianoId,
        measurements: Object.fromEntries(this.measurements),
        customPianos: this.customPianos,
        settings: this.settings,
        tuningProgress: Object.fromEntries(
          Array.from(this.tuningProgress.entries()).map(([k, v]) => [
            k,
            Object.fromEntries(v),
          ]),
        ),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // 隐私模式等场景下降级为内存态
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as PersistShape;
      this.selectedPianoId = data.selectedPianoId;
      this.measurements = new Map(Object.entries(data.measurements ?? {}));
      this.customPianos = data.customPianos ?? [];
      if (data.settings) this.settings = data.settings;
      this.tuningProgress = new Map(
        Object.entries(data.tuningProgress ?? {}).map(([k, v]) => [
          k,
          new Map(Object.entries(v).map(([m, c]) => [Number(m), c])),
        ]),
      );
    } catch {
      /* 损坏的存档直接忽略 */
    }
  }
}

export const store = new Store();
