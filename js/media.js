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

// Lee metadatos (dimensiones/duración) de un archivo antes de guardarlo.
function probe(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    if (file.type.startsWith('video')) {
      const v = document.createElement('video');
      v.preload = 'metadata'; v.muted = true;
      v.onloadedmetadata = () => {
        resolve({ duration: v.duration || 0, width: v.videoWidth, height: v.videoHeight });
        URL.revokeObjectURL(url);
      };
      v.onerror = () => { resolve({ duration: 0, width: 1080, height: 1920 }); URL.revokeObjectURL(url); };
      v.src = url;
    } else if (file.type.startsWith('image')) {
      const img = new Image();
      img.onload = () => { resolve({ duration: 0, width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(url); };
      img.onerror = () => { resolve({ duration: 0, width: 1080, height: 1920 }); URL.revokeObjectURL(url); };
      img.src = url;
    } else if (file.type.startsWith('audio')) {
      const a = document.createElement('audio');
      a.preload = 'metadata';
      a.onloadedmetadata = () => { resolve({ duration: a.duration || 0, width: 0, height: 0 }); URL.revokeObjectURL(url); };
      a.onerror = () => { resolve({ duration: 0, width: 0, height: 0 }); URL.revokeObjectURL(url); };
      a.src = url;
    } else {
      resolve({ duration: 0, width: 0, height: 0 });
    }
  });
}

// Genera una miniatura (dataURL) para video/imagen.
async function makeThumb(file, kind) {
  try {
    const url = URL.createObjectURL(file);
    const canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 160;
    const ctx = canvas.getContext('2d');
    const drawCover = (media, mw, mh) => {
      const scale = Math.max(160 / mw, 160 / mh);
      const w = mw * scale, h = mh * scale;
      ctx.drawImage(media, (160 - w) / 2, (160 - h) / 2, w, h);
    };
    if (kind === 'image') {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      drawCover(img, img.naturalWidth, img.naturalHeight);
    } else if (kind === 'video') {
      const v = document.createElement('video');
      v.muted = true; v.src = url;
      await new Promise((res) => { v.onloadeddata = res; v.onerror = res; });
      try { v.currentTime = Math.min(0.5, (v.duration || 1) / 3); } catch {}
      await new Promise((res) => { v.onseeked = res; setTimeout(res, 400); });
      drawCover(v, v.videoWidth || 160, v.videoHeight || 160);
    } else {
      URL.revokeObjectURL(url);
      return null;
    }
    URL.revokeObjectURL(url);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return null;
  }
}

// Importa un archivo: lo guarda como Blob en IndexedDB y devuelve su registro.
export async function importFile(file) {
  const kind = file.type.startsWith('video') ? 'video'
    : file.type.startsWith('image') ? 'image'
    : file.type.startsWith('audio') ? 'audio' : 'other';
  const meta = await probe(file);
  const thumb = kind === 'audio' ? null : await makeThumb(file, kind);
  const record = {
    id: uid(),
    name: file.name,
    mime: file.type,
    kind,
    blob: file,
    duration: meta.duration,
    width: meta.width,
    height: meta.height,
    thumb,
    createdAt: Date.now(),
  };
  await saveMedia(record);
  mediaCache.set(record.id, record);
  return record;
}

// ---------------- Grafo de audio (Web Audio) ----------------
// Se usa tanto para escuchar en la vista previa como para exportar.
let audioCtx = null;
let streamDest = null;
const clipNodes = new Map(); // clipId -> { gain }

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
