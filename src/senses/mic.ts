/**
 * Microphone loudness meter (RMS of the time-domain signal).
 *
 * Loudness only: nothing is recorded, saved or sent anywhere. The analyser
 * hangs off the audio engine's context but is never connected to
 * ctx.destination, so the mic is never played back.
 */

import { CONFIG } from '../config.js';
import type { MicLike, MicStatus } from '../game/contracts.js';

const FFT_SIZE = 1024;
/** Calibration keeps the most recent N per-update RMS samples (~55 s at 72 fps). */
const MAX_CALIBRATION_SAMPLES = 4096;

export class Mic implements MicLike {
  private _status: MicStatus = 'idle';
  private _level = 0;
  private _baseline: number | null = null;
  private _settings: MediaTrackSettings | null = null;

  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private pending: Promise<MicStatus> | null = null;

  private readonly buf = new Float32Array(FFT_SIZE);
  private readonly samples = new Float32Array(MAX_CALIBRATION_SAMPLES);
  private readonly sortScratch = new Float32Array(MAX_CALIBRATION_SAMPLES);
  private sampleCount = 0;
  private sampleHead = 0;
  private calibrating = false;

  constructor(private readonly ctx: AudioContext) {
    // Keep the meter alive if the context gets suspended while we're listening.
    ctx.addEventListener('statechange', () => this.ensureRunning());
  }

  get status(): MicStatus {
    return this._status;
  }
  get level(): number {
    return this._level;
  }
  get baseline(): number | null {
    return this._baseline;
  }
  get threshold(): number {
    return this._baseline === null ? Infinity : this._baseline * CONFIG.mic.noiseRatio;
  }
  get noisy(): boolean {
    return this._level > this.threshold;
  }
  get settings(): MediaTrackSettings | null {
    return this._settings;
  }

  request(): Promise<MicStatus> {
    if (this._status === 'granted') return Promise.resolve('granted');
    if (this.pending) return this.pending;
    this.pending = this.open()
      .catch((err: unknown): MicStatus => {
        console.warn('[mic] setup failed:', err);
        return 'unavailable';
      })
      .then((s) => {
        this._status = s;
        this.pending = null;
        return s;
      });
    return this.pending;
  }

  beginCalibration(): void {
    this.sampleCount = 0;
    this.sampleHead = 0;
    this.calibrating = true;
  }

  endCalibration(): number | null {
    this.calibrating = false;
    if (this._status !== 'granted') return null;
    // Median of the window, so one cough or chair creak doesn't skew it.
    const n = this.sampleCount;
    let room = this._level;
    if (n > 0) {
      const sorted = this.sortScratch.subarray(0, n);
      sorted.set(this.samples.subarray(0, n));
      sorted.sort();
      room = n % 2 ? sorted[(n - 1) >> 1] : 0.5 * (sorted[n / 2 - 1] + sorted[n / 2]);
    }
    this._baseline = Math.max(room, CONFIG.mic.baselineFloorRms);
    console.log(
      `[mic] room level ${this._baseline.toFixed(4)} RMS (median of ${n} samples), threshold ${this.threshold.toFixed(4)}`,
    );
    return this._baseline;
  }

  update(dt: number): void {
    const analyser = this.analyser;
    if (this._status !== 'granted' || !analyser) return;

    // A suspended context hands back a stale buffer: treat it as silence rather
    // than letting a frozen loud sample keep `noisy` true.
    let rms = 0;
    const live = this.ctx.state === 'running';
    if (live) {
      const buf = this.buf;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      rms = Math.sqrt(sum / buf.length);
    }

    if (dt > 0) this._level += (rms - this._level) * (1 - Math.exp(-dt / CONFIG.mic.levelSmoothingSec));
    else this._level = rms;

    if (this.calibrating && live) {
      this.samples[this.sampleHead] = rms;
      this.sampleHead = (this.sampleHead + 1) % MAX_CALIBRATION_SAMPLES;
      if (this.sampleCount < MAX_CALIBRATION_SAMPLES) this.sampleCount++;
    }
  }

  private async open(): Promise<MicStatus> {
    if (!navigator.mediaDevices?.getUserMedia) {
      console.warn('[mic] getUserMedia is not available (needs HTTPS and a browser with a mic)');
      return 'unavailable';
    }
    this._status = 'requesting';
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
        video: false,
      });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name ?? '';
      console.warn('[mic] getUserMedia failed:', name, err);
      return name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable';
    }

    // Anything below can throw (e.g. a closed context, or a sample-rate mismatch in
    // createMediaStreamSource): give the mic back and carry on without it.
    try {
      return this.attach(stream);
    } catch (err) {
      console.warn('[mic] could not start the level meter:', err);
      this.release(stream);
      this._settings = null;
      return 'unavailable';
    }
  }

  /** Hang the analyser off a granted stream. May throw; the caller releases the stream. */
  private attach(stream: MediaStream): MicStatus {
    const track = stream.getAudioTracks()[0];
    if (!track) {
      console.warn('[mic] stream has no audio track');
      this.release(stream);
      return 'unavailable';
    }
    // What the browser actually applied (Quest may ignore EC/NS/AGC = false).
    this._settings = track.getSettings();
    console.log('[mic] granted; track settings', JSON.stringify(this._settings));

    this.stream = stream;
    this.source = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.source.connect(this.analyser); // never to ctx.destination
    track.addEventListener('ended', this.onTrackEnded);
    track.addEventListener('mute', () => console.warn('[mic] track muted by the system'));
    track.addEventListener('unmute', () => console.log('[mic] track unmuted'));

    // request() runs inside the title-page click, so a resume here has user activation.
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    return 'granted';
  }

  /** Stop the stream and drop the meter's nodes. */
  private release(stream: MediaStream | null): void {
    stream?.getAudioTracks()[0]?.removeEventListener('ended', this.onTrackEnded);
    this.source?.disconnect();
    stream?.getTracks().forEach((t) => t.stop());
    this.source = null;
    this.analyser = null;
    this.stream = null;
  }

  /** Permission revoked or device lost: the Listener has to switch off. */
  private readonly onTrackEnded = (): void => {
    console.warn('[mic] track ended (permission revoked or device lost)');
    this.release(this.stream);
    this.calibrating = false;
    this._level = 0;
    this._status = 'unavailable';
  };

  private ensureRunning(): void {
    const state = this.ctx.state as string;
    if (this._status === 'granted' && state !== 'running' && state !== 'closed') {
      this.ctx.resume().catch(() => {});
    }
  }
}
