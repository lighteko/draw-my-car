"use client";

/*
 * Game audio. Lazy throughout, because browsers only allow playback after a user gesture and
 * this module is imported long before one happens.
 *
 * One-shots play a file from /sfx when one is present and fall back to a synthesised tone
 * when it is not, so the game always has sound and shipping assets is optional. The engine
 * note is always synthesised: it has to follow speed continuously, which a sample cannot.
 */

const MUTED_STORAGE_KEY = "dmc_muted";
const MASTER_VOLUME = 0.25;

let audioContext: AudioContext | null = null;
let masterGain: GainNode | null = null;
let engine: EngineVoice | null = null;
let muted = false;

/**
 * The engine is a small stack rather than one oscillator: a single saw sweeping up the scale
 * is a mosquito, because all its energy sits in the high harmonics. A low fundamental with a
 * sub octave, a detuned partner for beating, and a resonant lowpass that only opens up with
 * speed gives the low-end body an engine needs; a breath of filtered noise on top keeps it
 * from sounding like a pure tone.
 */
interface EngineVoice {
  sub: OscillatorNode;
  main: OscillatorNode;
  detune: OscillatorNode;
  noise: AudioBufferSourceNode;
  noiseGain: GainNode;
  filter: BiquadFilterNode;
  gain: GainNode;
}

// Fundamental at rest and at the top of the speed range, and the lowpass sweep that goes
// with it. Cutoff climbing with revs is what makes it read as "opening up".
const ENGINE_IDLE_HZ = 42;
const ENGINE_TOP_HZ = 190;
const ENGINE_IDLE_CUTOFF = 320;
const ENGINE_TOP_CUTOFF = 2400;
const ENGINE_SPEED_CAP = 220;

function createNoiseBuffer(context: AudioContext): AudioBuffer {
  const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

type AudioContextWindow = Window & {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
};

function readMuted(): boolean {
  if (typeof window === "undefined") return muted;
  try {
    return window.localStorage.getItem(MUTED_STORAGE_KEY) === "true";
  } catch {
    return muted;
  }
}

function getRunningContext(): AudioContext | null {
  if (!audioContext || audioContext.state !== "running" || !masterGain) {
    return null;
  }
  return audioContext;
}

function playTone(
  startFrequency: number,
  endFrequency: number,
  duration: number,
  peakGain: number,
  type: OscillatorType = "sine",
  delay = 0,
): void {
  try {
    const context = getRunningContext();
    if (!context || !masterGain) return;
    const now = context.currentTime + delay;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(startFrequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(endFrequency, now + duration);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain);
    gain.connect(masterGain);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  } catch {
    // Audio can be unavailable or revoked by the browser at any time.
  }
}

export async function unlockAudio(): Promise<void> {
  try {
    if (!audioContext) {
      const browserWindow = window as AudioContextWindow;
      const AudioContextConstructor =
        browserWindow.AudioContext ?? browserWindow.webkitAudioContext;
      if (!AudioContextConstructor) return;
      const context = new AudioContextConstructor();
      audioContext = context;
      masterGain = context.createGain();
      masterGain.gain.value = muted || readMuted() ? 0 : MASTER_VOLUME;
      masterGain.connect(context.destination);
    }
    if (audioContext.state === "suspended") await audioContext.resume();
    if (audioContext.state === "running") loadSamples(audioContext);
  } catch {
    // Some embeds and browsers block AudioContext construction or resume.
  }
}

function createEngine(context: AudioContext, destination: GainNode): EngineVoice | null {
  try {
    const gain = context.createGain();
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = ENGINE_IDLE_CUTOFF;
    filter.Q.value = 6;

    const sub = context.createOscillator();
    sub.type = "square";
    const main = context.createOscillator();
    main.type = "sawtooth";
    const detune = context.createOscillator();
    detune.type = "sawtooth";
    detune.detune.value = 14; // a few cents apart, so the two saws beat against each other

    const noise = context.createBufferSource();
    noise.buffer = createNoiseBuffer(context);
    noise.loop = true;
    const noiseFilter = context.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = 900;
    const noiseGain = context.createGain();
    noiseGain.gain.value = 0;

    // Everything meets at the lowpass, so one cutoff sweep shapes the whole voice.
    const subGain = context.createGain();
    subGain.gain.value = 0.55;
    sub.connect(subGain).connect(filter);
    main.connect(filter);
    detune.connect(filter);
    noise.connect(noiseFilter).connect(noiseGain).connect(filter);
    filter.connect(gain).connect(destination);

    gain.gain.value = 0;
    sub.start();
    main.start();
    detune.start();
    noise.start();
    return { sub, main, detune, noise, noiseGain, filter, gain };
  } catch {
    return null;
  }
}

export function setEngineSpeed(kmh: number): void {
  try {
    const context = getRunningContext();
    if (!context || !masterGain) return;
    if (!engine) {
      // Only adopt the voice once it is fully wired and started: assigning a half-built one
      // would make every later call skip creation and leave the engine silent for good.
      engine = createEngine(context, masterGain);
      if (!engine) return;
    }
    const now = context.currentTime;
    const speed = Math.max(0, Math.min(ENGINE_SPEED_CAP, Number.isFinite(kmh) ? kmh : 0));
    const t = speed / ENGINE_SPEED_CAP;
    const fundamental = ENGINE_IDLE_HZ + (ENGINE_TOP_HZ - ENGINE_IDLE_HZ) * t;

    // setTargetAtTime only touches AudioParams, so this stays cheap at frame rate.
    engine.main.frequency.setTargetAtTime(fundamental, now, 0.05);
    engine.detune.frequency.setTargetAtTime(fundamental, now, 0.05);
    engine.sub.frequency.setTargetAtTime(fundamental / 2, now, 0.05);
    engine.filter.frequency.setTargetAtTime(
      ENGINE_IDLE_CUTOFF + (ENGINE_TOP_CUTOFF - ENGINE_IDLE_CUTOFF) * t * t,
      now,
      0.06,
    );
    engine.noiseGain.gain.setTargetAtTime(0.006 + t * 0.05, now, 0.06);
    engine.gain.gain.setTargetAtTime(0.05 + t * 0.11, now, 0.05);
  } catch {
    // Keep the game loop safe if an audio node becomes unusable.
  }
}

export function stopEngine(): void {
  const voice = engine;
  engine = null;
  try {
    if (!audioContext || !voice) return;
    const now = audioContext.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setTargetAtTime(0.0001, now, 0.08);
    const stopAt = now + 0.4;
    voice.sub.stop(stopAt);
    voice.main.stop(stopAt);
    voice.detune.stop(stopAt);
    voice.noise.stop(stopAt);
  } catch {
    // Nodes may already be released; the voice is dropped either way.
  }
}

/**
 * One-shots prefer a real recording and fall back to the synth.
 *
 * Drop a CC0 file at the path below and it takes over automatically — no code change. A
 * missing file is the normal case, not an error: the fetch fails quietly and the tone plays.
 * The engine loop is deliberately not in here; it has to track speed continuously, which a
 * one-shot sample cannot do.
 */
const SAMPLE_PATHS = {
  countdown: "/sfx/countdown.ogg",
  go: "/sfx/go.ogg",
  finish: "/sfx/finish.ogg",
  wrongWay: "/sfx/wrong-way.ogg",
} as const;
type SampleName = keyof typeof SAMPLE_PATHS;

const samples = new Map<SampleName, AudioBuffer>();
let samplesRequested = false;

function loadSamples(context: AudioContext): void {
  if (samplesRequested) return;
  samplesRequested = true;
  (Object.keys(SAMPLE_PATHS) as SampleName[]).forEach((name) => {
    void fetch(SAMPLE_PATHS[name])
      .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error("missing"))))
      .then((bytes) => context.decodeAudioData(bytes))
      .then((buffer) => samples.set(name, buffer))
      .catch(() => {
        /* no file shipped for this sound — the synthesised fallback covers it */
      });
  });
}

/** Plays the sample if one is loaded. Returns false when the caller should synthesise. */
function playSample(name: SampleName, gainValue = 1): boolean {
  try {
    const context = getRunningContext();
    const buffer = samples.get(name);
    if (!context || !masterGain || !buffer) return false;
    const source = context.createBufferSource();
    const gain = context.createGain();
    gain.gain.value = gainValue;
    source.buffer = buffer;
    source.connect(gain).connect(masterGain);
    source.start();
    return true;
  } catch {
    return false;
  }
}

export function playCountdownBeep(): void {
  if (playSample("countdown")) return;
  playTone(520, 430, 0.12, 0.16, "triangle");
}

export function playGoHorn(): void {
  if (playSample("go")) return;
  playTone(440, 660, 0.42, 0.18, "square");
}

export function playFinishFanfare(): void {
  if (playSample("finish")) return;
  playTone(523, 523, 0.16, 0.14, "triangle", 0);
  playTone(659, 659, 0.16, 0.14, "triangle", 0.14);
  playTone(784, 784, 0.22, 0.16, "triangle", 0.28);
}

export function playWrongWay(): void {
  if (playSample("wrongWay")) return;
  // Both tones are scheduled on the audio clock rather than a timer, so the pair stays
  // tight even when the main thread is busy with a physics step.
  playTone(180, 140, 0.18, 0.16, "sawtooth");
  playTone(180, 140, 0.18, 0.16, "sawtooth", 0.2);
}

export function setMuted(value: boolean): void {
  muted = value;
  try {
    window.localStorage.setItem(MUTED_STORAGE_KEY, String(value));
  } catch {
    // Storage may be disabled; the in-memory setting still applies.
  }
  try {
    if (masterGain && audioContext) {
      masterGain.gain.setTargetAtTime(value ? 0 : MASTER_VOLUME, audioContext.currentTime, 0.02);
    }
  } catch {
    // Muting remains best effort if the audio graph is unavailable.
  }
}

export function isMuted(): boolean {
  muted = readMuted();
  return muted;
}
