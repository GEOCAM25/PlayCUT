// audioextract.js — Extrae el audio de un video (o audio) y lo convierte a MP3
// en el propio dispositivo, usando lamejs (incrustado) + Web Audio.

function lame() {
  const L = window.lamejs;
  if (!L || !L.Mp3Encoder) throw new Error('Codificador MP3 no disponible');
  return L;
}

function floatToInt16(float) {
  const out = new Int16Array(float.length);
  for (let i = 0; i < float.length; i++) {
    let s = Math.max(-1, Math.min(1, float[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return out;
}

// Codifica un AudioBuffer a MP3 (Blob).
function encodeAudioBuffer(audioBuf, onProgress) {
  const L = lame();
  const channels = Math.min(2, audioBuf.numberOfChannels);
  const sampleRate = audioBuf.sampleRate;
  const enc = new L.Mp3Encoder(channels, sampleRate, 160);
  const left = floatToInt16(audioBuf.getChannelData(0));
  const right = channels > 1 ? floatToInt16(audioBuf.getChannelData(1)) : null;
  const block = 1152;
  const data = [];
  for (let i = 0; i < left.length; i += block) {
    const l = left.subarray(i, i + block);
    let chunk;
    if (right) chunk = enc.encodeBuffer(l, right.subarray(i, i + block));
    else chunk = enc.encodeBuffer(l);
    if (chunk.length) data.push(new Uint8Array(chunk));
    if (onProgress && (i % (block * 40) === 0)) onProgress(Math.min(0.98, i / left.length));
  }
  const end = enc.flush();
  if (end.length) data.push(new Uint8Array(end));
  if (onProgress) onProgress(1);
  return new Blob(data, { type: 'audio/mpeg' });
}

// Captura en tiempo real (respaldo) cuando decodeAudioData no puede con el archivo.
async function realtimeToBuffer(blob, onProgress) {
  const url = URL.createObjectURL(blob);
  const el = document.createElement('video');
  el.src = url; el.crossOrigin = 'anonymous';
  await new Promise((res, rej) => { el.onloadedmetadata = res; el.onerror = () => rej(new Error('No se pudo leer el archivo')); });
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  await ctx.resume();
  const src = ctx.createMediaElementSource(el);
  const proc = ctx.createScriptProcessor(4096, 2, 2);
  const silent = ctx.createGain(); silent.gain.value = 0;
  src.connect(proc); proc.connect(silent); silent.connect(ctx.destination);
  const chans = [[], []];
  proc.onaudioprocess = (e) => {
    const ib = e.inputBuffer;
    chans[0].push(new Float32Array(ib.getChannelData(0)));
    chans[1].push(new Float32Array(ib.numberOfChannels > 1 ? ib.getChannelData(1) : ib.getChannelData(0)));
    if (onProgress && el.duration) onProgress(Math.min(0.9, el.currentTime / el.duration) * 0.9);
  };
  el.play();
  await new Promise((res) => { el.onended = res; });
  proc.disconnect(); src.disconnect(); ctx.close(); URL.revokeObjectURL(url);
  const merge = (arr) => { let n = 0; for (const a of arr) n += a.length; const o = new Float32Array(n); let k = 0; for (const a of arr) { o.set(a, k); k += a.length; } return o; };
  const L = merge(chans[0]), R = merge(chans[1]);
  const sr = ctx.sampleRate;
  // Empaqueta como pseudo AudioBuffer para reutilizar el codificador.
  return { numberOfChannels: 2, sampleRate: sr, getChannelData: (i) => (i === 0 ? L : R) };
}

// API principal: Blob de medio -> Blob MP3.
export async function mediaToMp3(blob, onProgress) {
  lame(); // asegura codificador
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  try {
    const buf = await blob.arrayBuffer();
    const audioBuf = await ctx.decodeAudioData(buf.slice(0));
    ctx.close();
    if (!audioBuf || audioBuf.length === 0) throw new Error('sin audio');
    return encodeAudioBuffer(audioBuf, onProgress);
  } catch (e) {
    try { ctx.close(); } catch {}
    // Respaldo: reproducción en tiempo real.
    const pseudo = await realtimeToBuffer(blob, onProgress);
    if (!pseudo.getChannelData(0).length) throw new Error('El archivo no tiene audio');
    return encodeAudioBuffer(pseudo, onProgress);
  }
}
