/**
 * 页面共享的音频会话:封装引擎在"麦克风 / 模拟弦"两种模式下的启停,
 * 页面只订阅帧回调。
 */

import { AudioEngine, AnalysisFrame } from '../audio/engine';
import { store } from '../state/store';
import type { SynthOptions } from '../audio/synth';

class AudioSession {
  engine = new AudioEngine();
  private frameListeners = new Set<(f: AnalysisFrame) => void>();
  private snapshotListeners = new Set<(sr: number, s: Float32Array) => void>();
  private activeKey: SynthOptions | null = null;
  started = false;

  constructor() {
    this.engine.onFrame = (f) => this.frameListeners.forEach((fn) => fn(f));
    this.engine.onSnapshot = (sr, s) =>
      this.snapshotListeners.forEach((fn) => fn(sr, s));
  }

  onFrame(fn: (f: AnalysisFrame) => void): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  onSnapshot(fn: (sr: number, s: Float32Array) => void): () => void {
    this.snapshotListeners.add(fn);
    return () => this.snapshotListeners.delete(fn);
  }

  /** 启动当前模式;demo 模式传入合成参数 */
  async start(demoOpts?: SynthOptions): Promise<void> {
    if (store.settings.demoMode) {
      if (!demoOpts) throw new Error('演示模式需要合成参数');
      this.activeKey = demoOpts;
      await this.engine.startDemo(demoOpts);
    } else {
      await this.engine.startMic();
    }
    this.started = true;
  }

  /** 演示模式热切换弦参数 */
  async switchDemo(opts: SynthOptions): Promise<void> {
    this.activeKey = opts;
    if (this.started && this.engine.mode === 'demo') {
      await this.engine.updateDemo(opts);
    } else {
      await this.start(opts);
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.engine.stop();
  }

  get latencyMs(): number {
    return this.engine.lastLatencyMs;
  }
}

export const session = new AudioSession();
