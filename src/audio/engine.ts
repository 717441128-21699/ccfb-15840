/**
 * 主线程音频引擎
 *
 * 负责 AudioContext 生命周期、麦克风/模拟弦两路输入、AudioWorklet 装载,
 * 以及端到端延迟测量。分析帧由 worklet 推送,引擎只做转发与格式转换。
 */

import type { Peak } from '../math/fft';
import { synthesizeString, toAudioBuffer, type SynthOptions } from './synth';
import workletUrl from './tuning-worklet.js?url';

export interface AnalysisFrame {
  sampleRate: number;
  fftSize: number;
  binHz: number;
  rms: number;
  frame: number;
  audioTime: number;
  peaks: Peak[];
  /** 下采样后的幅值谱(每 2 个 bin 取一个) */
  magnitude: Float32Array;
  /** 引擎打戳:到达主线程的 performance.now()(ms) */
  receivedAt: number;
}

interface WorkletFrameMessage {
  type: 'frame';
  sampleRate: number;
  fftSize: number;
  binHz: number;
  rms: number;
  frame: number;
  audioTime: number;
  peaks: { bin: number[]; freq: number[]; mag: number[] };
  magnitude: Float32Array;
}

interface SnapshotMessage {
  type: 'snapshot';
  sampleRate: number;
  samples: Float32Array;
}

export type EngineMode = 'mic' | 'demo';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private source: AudioNode | null = null;
  private silentGain: GainNode | null = null;
  private demoBuffer: AudioBuffer | null = null;
  private demoSource: AudioBufferSourceNode | null = null;
  mode: EngineMode | null = null;
  running = false;

  /** 帧回调(UI/分析器订阅) */
  onFrame: ((frame: AnalysisFrame) => void) | null = null;
  onSnapshot: ((sampleRate: number, samples: Float32Array) => void) | null = null;

  /** 最近一次端到端延迟(worklet 音频时刻 → 主线程收到),ms */
  lastLatencyMs = 0;

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  private async ensureContext(): Promise<AudioContext> {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      await this.ctx.audioWorklet.addModule(workletUrl);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }

  private attachNode(ctx: AudioContext): AudioWorkletNode {
    const node = new AudioWorkletNode(ctx, 'tuning-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    node.port.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as WorkletFrameMessage | SnapshotMessage;
      if (msg.type === 'frame') {
        const f = msg as WorkletFrameMessage;
        const receivedAt = performance.now();
        // worklet 的 audioTime 与 ctx.currentTime 同一时钟域;
        // 帧在 worklet 处理完成后到主线程被处理的排队延迟:
        const queueMs = (ctx.currentTime - f.audioTime) * 1000;
        // 端到端预算 = 采集/输入缓冲 + 半窗(50% 重叠的有效更新周期)+ 排队
        const windowMs = (f.fftSize / 2 / f.sampleRate) * 1000;
        const inputMs =
          (ctx.baseLatency + ctx.outputLatency) * 1000;
        this.lastLatencyMs = Math.max(0, queueMs) + windowMs + inputMs;

        const peaks: Peak[] = f.peaks.freq.map((frequency, i) => ({
          frequency,
          magnitude: f.peaks.mag[i],
          bin: f.peaks.bin[i],
        }));
        this.onFrame?.({
          sampleRate: f.sampleRate,
          fftSize: f.fftSize,
          binHz: f.binHz,
          rms: f.rms,
          frame: f.frame,
          audioTime: f.audioTime,
          peaks,
          magnitude: f.magnitude,
          receivedAt,
        });
      } else if (msg.type === 'snapshot') {
        this.onSnapshot?.(msg.sampleRate, msg.samples);
      }
    };
    this.node = node;
    return node;
  }

  /** 启动麦克风输入 */
  async startMic(): Promise<void> {
    await this.stop();
    const ctx = await this.ensureContext();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    this.source = ctx.createMediaStreamSource(this.stream);
    const node = this.attachNode(ctx);
    this.source.connect(node);
    // 零增益节点保持图存活但不回放(避免啸叫)
    this.silentGain = ctx.createGain();
    this.silentGain.gain.value = 0;
    node.connect(this.silentGain);
    this.silentGain.connect(ctx.destination);
    this.mode = 'mic';
    this.running = true;
  }

  /**
   * 启动模拟弦:合成刚性弦音 → 经扬声器/耳机播放,
   * 同时把同一信号送进 worklet 分析(离线可验证完整链路)。
   */
  async startDemo(opts: SynthOptions): Promise<void> {
    await this.stop();
    const ctx = await this.ensureContext();
    const withSr: SynthOptions = {
      ...opts,
      sampleRate: ctx.sampleRate,
    };
    const samples = synthesizeString(withSr);
    this.demoBuffer = toAudioBuffer(ctx, samples);
    const src = ctx.createBufferSource();
    src.buffer = this.demoBuffer;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0.6;
    src.connect(gain);
    gain.connect(ctx.destination);

    const node = this.attachNode(ctx);
    gain.connect(node);
    this.silentGain = gain;
    this.source = src;
    this.demoSource = src;
    src.start();
    this.mode = 'demo';
    this.running = true;
  }

  /** 演示模式下更换弦参数(热切换,不重启 context) */
  async updateDemo(opts: SynthOptions): Promise<void> {
    if (this.mode !== 'demo' || !this.ctx) {
      await this.startDemo(opts);
      return;
    }
    const ctx = this.ctx;
    const old = this.demoSource;
    const samples = synthesizeString({ ...opts, sampleRate: ctx.sampleRate });
    this.demoBuffer = toAudioBuffer(ctx, samples);
    const src = ctx.createBufferSource();
    src.buffer = this.demoBuffer;
    src.loop = true;
    src.connect(this.silentGain!);
    src.start();
    this.demoSource = src;
    this.source = src;
    if (old) {
      try {
        old.stop();
      } catch {
        /* 已停止 */
      }
    }
  }

  requestSnapshot(): void {
    this.node?.port.postMessage({ type: 'snapshot' });
  }

  configure(cfg: { fftSize?: number; minPeakRatio?: number }): void {
    this.node?.port.postMessage({ type: 'config', ...cfg });
  }

  async stop(): Promise<void> {
    if (this.demoSource) {
      try {
        this.demoSource.stop();
      } catch {
        /* noop */
      }
      this.demoSource = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.node) {
      try {
        this.node.disconnect();
      } catch {
        /* noop */
      }
      this.node.port.onmessage = null;
      this.node = null;
    }
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        /* noop */
      }
      this.source = null;
    }
    this.silentGain = null;
    this.running = false;
    this.mode = null;
  }
}
