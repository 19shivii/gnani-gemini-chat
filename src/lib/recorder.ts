// Records one utterance from the mic, auto-stops after silence, returns 16 kHz mono WAV (base64).
export type Mic = { stream: MediaStream; ctx: AudioContext };

export async function openMic(): Promise<Mic> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext();
  return { stream, ctx };
}

export function closeMic(m: Mic | null) {
  if (!m) return;
  m.stream.getTracks().forEach((t) => t.stop());
  m.ctx.close().catch(() => {});
}

export function recordUtterance(
  mic: Mic,
  opts: { signal: AbortSignal; onLevel?: (v: number) => void; onSpeechStart?: () => void },
): Promise<string | null> {
  return new Promise((resolve) => {
    const { ctx, stream } = mic;
    if (ctx.state === "suspended") ctx.resume();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    let speaking = false;
    let silentMs = 0;
    let totalMs = 0;
    let waitMs = 0;
    const frameMs = (4096 / ctx.sampleRate) * 1000;

    const finish = (keep: boolean) => {
      proc.disconnect();
      src.disconnect();
      opts.signal.removeEventListener("abort", onAbort);
      if (!keep || !speaking) return resolve(null);
      resolve(encodeWav(chunks, ctx.sampleRate));
    };
    const onAbort = () => finish(false);
    opts.signal.addEventListener("abort", onAbort);

    proc.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
      const rms = Math.sqrt(sum / d.length);
      opts.onLevel?.(Math.min(1, rms * 12));
      const loud = rms > 0.02;
      if (!speaking) {
        // keep short pre-roll
        chunks.push(new Float32Array(d));
        if (chunks.length > 3) chunks.shift();
        if (loud) {
          speaking = true;
          opts.onSpeechStart?.();
        } else {
          waitMs += frameMs;
          if (waitMs > 30000) finish(false);
        }
        return;
      }
      chunks.push(new Float32Array(d));
      totalMs += frameMs;
      silentMs = loud ? 0 : silentMs + frameMs;
      if (silentMs > 1300 || totalMs > 25000) finish(true);
    };
    src.connect(proc);
    proc.connect(ctx.destination);
  });
}

function encodeWav(chunks: Float32Array[], rate: number): string {
  const len = chunks.reduce((a, c) => a + c.length, 0);
  const all = new Float32Array(len);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  const target = 16000;
  const ratio = rate / target;
  const outLen = Math.floor(len / ratio);
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = Math.max(-1, Math.min(1, all[Math.floor(i * ratio)]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const w = (p: number, s: string) => [...s].forEach((ch, i) => v.setUint8(p + i, ch.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, target, true);
  v.setUint32(28, target * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
