/** Own recordings for auto-call campaigns: microphone recording and any audio file the browser can decode → 8 kHz mono 16-bit WAV (phone quality). */

export const MAX_SECONDS = 75; // the server rejects longer clips (request size limit)
const RATE = 8000;

/** Decodes audio (webm/ogg from the microphone, mp3/m4a/wav files…), mixes to mono, resamples to 8 kHz, peak-normalises, encodes WAV. */
export async function toPhoneWav(blob: Blob): Promise<{ base64: string; seconds: number; url: string }> {
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try { decoded = await ctx.decodeAudioData(await blob.arrayBuffer()); }
  catch { throw new Error('This audio file could not be read. Try an MP3, WAV or M4A file.'); }
  finally { void ctx.close(); }
  const seconds = decoded.duration;
  if (seconds < 1) throw new Error('The recording is too short.');
  if (seconds > MAX_SECONDS) throw new Error(`Keep the recording under ${MAX_SECONDS} seconds (this one is ${Math.round(seconds)} s).`);
  const off = new OfflineAudioContext(1, Math.ceil(seconds * RATE), RATE); // 1 channel: the browser mixes down while resampling
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  let peak = 0;
  for (const x of pcm) peak = Math.max(peak, Math.abs(x));
  const gain = peak > 0.01 ? 0.9 / peak : 1;
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const ascii = (o: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  ascii(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ascii(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  pcm.forEach((x, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x * gain)) * 0x7fff, true));
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { base64: btoa(bin), seconds, url: URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })) };
}

/** Starts recording from the microphone; call the returned stop() to get the audio. */
export async function startRecording(): Promise<{ stop: () => Promise<Blob> }> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const rec = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.start();
  return {
    stop: () => new Promise((done) => {
      rec.onstop = () => { stream.getTracks().forEach((t) => t.stop()); done(new Blob(chunks, { type: rec.mimeType })); };
      rec.stop();
    }),
  };
}
