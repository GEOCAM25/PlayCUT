// media.js — Importación de archivos, miniaturas y grafo de audio.
// Cada clip tiene su propio elemento de reproducción para poder mezclar
// volúmenes de forma independiente y exportar con Web Audio.

import { uid } from './state.js';
import { saveMedia, getMedia } from './db.js';

const blobURLCache = new Map();   // mediaId -> objectURL
const mediaCache = new Map();     // mediaId -> media record

export async function loadMediaRecord(id) {
  if (mediaCache.has(id)) return mediaCache.get(id);
  const rec = await getMedia(id);
  if (rec) mediaCache.set(id, rec);
  return rec;
}

export async function blobURLFor(mediaId) {
  if (blobURLCache.has(mediaId)) return blobURLCache.get(mediaId);
  const rec = await loadMediaRecord(mediaId);
  if (!rec) return null;
  const url = URL.createObjectURL(rec.blob);
  blobURLCache.set(mediaId, url);
  return url;
}

// Detecta el tipo por MIME o, si falta (iPhone a veces manda type vacío), por
// la extensión del nombre.
export function detectKind(file) {
  const t = (file.type || '').toLowerCase();
  if (t.startsWith('video')) return 'video';
  if (t.startsWith('image')) return 'image';
  if (t.startsWith('audio')) return 'audio';
  const n = (file.name || '').toLowerCase();
  if (/\.(mp4|mov|m4v|webm|mkv|avi|3gp|hevc|ts)$/.test(n)) return 'video';
  if (/\.(jpe?g|png|gif|webp|heic|heif|bmp|avif)$/.test(n)) return 'image';
  if (/\.(mp3|wav|m4a|aac|ogg|oga|opus|flac)$/.test(n)) return 'audio';
  return 'other';
}

// Lee metadatos (dimensiones/duración). Nunca se cuelga: hay timeout de rescate.
function probe(file, kind) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); URL.revokeObjectURL(url); resolve(r); };
    const timer = setTimeout(() => finish({ duration: 0, width: 0, height: 0 }), 12000);
    if (kind === 'video') {
      const v = document.createElement('video');
      v.preload = 'metadata'; v.muted = true; v.playsInline = true;
      v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
      v.onloadedmetadata = () => finish({ duration: v.duration || 0, width: v.videoWidth || 0, height: v.videoHeight || 0 });
      v.onerror = () => finish({ duration: 0, width: 0, height: 0 });
      v.src = url;
    } else if (kind === 'image') {
      const img = new Image();
      img.onload = () => finish({ duration: 0, width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => finish({ duration: 0, width: 1080, height: 1920 });
      img.src = url;
    } else if (kind === 'audio') {
      const a = document.createElement('audio'); a.preload = 'metadata';
      a.onloadedmetadata = () => finish({ duration: a.duration || 0, width: 0, height: 0 });
      a.onerror = () => finish({ duration: 0, width: 0, height: 0 });
      a.src = url;
    } else finish({ duration: 0, width: 0, height: 0 });
  });
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('timeout'), ms))]);

// Genera una miniatura (dataURL) para video/imagen. Nunca se cuelga.
async function makeThumb(file, kind) {
  let url;
  try {
    url = URL.createObjectURL(file);
    const canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 160;
    const ctx = canvas.getContext('2d');
    const drawCover = (media, mw, mh) => {
      const scale = Math.max(160 / mw, 160 / mh);
      const w = mw * scale, h = mh * scale;
      ctx.drawImage(media, (160 - w) / 2, (160 - h) / 2, w, h);
    };
    if (kind === 'image') {
      const img = await withTimeout(new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; }), 8000);
      if (img === 'timeout' || !img.naturalWidth) return null;
      drawCover(img, img.naturalWidth, img.naturalHeight);
    } else if (kind === 'video') {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.src = url;
      await withTimeout(new Promise((res) => { v.onloadeddata = res; v.onerror = res; }), 8000);
      if (!v.videoWidth) return null;
      try { v.currentTime = Math.min(0.5, (v.duration || 1) / 3); } catch {}
      await withTimeout(new Promise((res) => { v.onseeked = res; }), 1500);
      drawCover(v, v.videoWidth || 160, v.videoHeight || 160);
    } else return null;
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return null;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

// Importa un archivo: lo guarda como Blob en IndexedDB y devuelve su registro.
export async function importFile(file) {
  const kind = detectKind(file);
  const meta = await probe(file, kind);
  const thumb = (kind === 'audio' || kind === 'other') ? null : await makeThumb(file, kind);
  const record = {
    id: uid(),
    name: file.name || (kind + '-' + Date.now()),
    mime: file.type || '',
    kind: kind === 'other' ? 'video' : kind, // por defecto tratamos lo desconocido como video
    blob: file,
    duration: meta.duration,
    width: meta.width,
    height: meta.height,
    thumb,
    createdAt: Date.now(),
  };
  await saveMedia(record); // puede lanzar si no hay espacio en el dispositivo
  mediaCache.set(record.id, record);
  return record;
}

// ---------------- Grafo de audio (Web Audio) ----------------
// Se usa tanto para escuchar en la vista previa como para exportar.
let audioCtx = null;
let streamDest = null;
const clipNodes = new Map(); // clipId -> { gain }

// Calcula la forma de onda (picos normalizados 0..1) de un audio, una sola vez.
const peaksCache = new Map();     // mediaId -> Float32Array
const peaksPending = new Map();   // mediaId -> Promise
export async function computePeaks(mediaId, buckets = 600) {
  if (peaksCache.has(mediaId)) return peaksCache.get(mediaId);
  if (peaksPending.has(mediaId)) return peaksPending.get(mediaId);
  const job = (async () => {
    const rec = await loadMediaRecord(mediaId);
    if (!rec || !rec.blob) return null;
    let buffer;
    try {
      const arr = await rec.blob.arrayBuffer();
      const ctx = getAudioContext();
      buffer = await new Promise((res, rej) => {
        const p = ctx.decodeAudioData(arr, res, rej);
        if (p && p.then) p.then(res, rej);
      });
    } catch (e) { return null; }
    const len = buffer.length;
    if (!len) return null;
    const per = Math.max(1, Math.floor(len / buckets));
    const d0 = buffer.getChannelData(0);
    const d1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
    const peaks = new Float32Array(buckets);
    let max = 1e-4;
    for (let b = 0; b < buckets; b++) {
      const s = b * per, e = Math.min(len, s + per);
      let p = 0;
      for (let i = s; i < e; i++) {
        let v = Math.abs(d0[i]);
        if (d1) { const v2 = Math.abs(d1[i]); if (v2 > v) v = v2; }
        if (v > p) p = v;
      }
      peaks[b] = p; if (p > max) max = p;
    }
    for (let b = 0; b < buckets; b++) peaks[b] /= max;
    peaksCache.set(mediaId, peaks);
    return peaks;
  })().finally(() => peaksPending.delete(mediaId));
  peaksPending.set(mediaId, job);
  return job;
}

export function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    streamDest = audioCtx.createMediaStreamDestination();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

export function getAudioStream() {
  getAudioContext();
  return streamDest.stream;
}

// Conecta un elemento multimedia al grafo (una sola vez por elemento).
export function connectElement(clipId, element) {
  const ctx = getAudioContext();
  if (clipNodes.has(clipId)) return clipNodes.get(clipId);
  let source;
  try {
    source = ctx.createMediaElementSource(element);
  } catch (e) {
    // Ya conectado antes: reutiliza el nodo guardado.
    return clipNodes.get(clipId) || null;
  }
  const gain = ctx.createGain();
  source.connect(gain);
  gain.connect(ctx.destination);   // altavoz (vista previa)
  gain.connect(streamDest);        // exportación
  const node = { source, gain };
  clipNodes.set(clipId, node);
  return node;
}

export function setClipGain(clipId, value) {
  const node = clipNodes.get(clipId);
  if (node) node.gain.gain.value = value;
}

export function revokeAll() {
  for (const url of blobURLCache.values()) URL.revokeObjectURL(url);
  blobURLCache.clear();
}
