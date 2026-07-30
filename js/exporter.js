// exporter.js — Exportación de video en el dispositivo, hasta 4K.
// Renderiza la timeline a un canvas de alta resolución y graba
// canvas + audio mezclado con MediaRecorder. Nada sale del dispositivo.

import { getAudioStream, getAudioContext } from './media.js';

function pickMimeType() {
  const candidates = [
    'video/mp4;codecs=h264,aac',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return 'video/webm';
}

// Tiers por lado más largo (px).
const TIER_LONG = { 480: 854, 720: 1280, 1080: 1920, 1440: 2560, 2160: 3840 };
const TIER_BITRATE = { 480: 3e6, 720: 6e6, 1080: 16e6, 1440: 28e6, 2160: 45e6 };

function even(n) { return Math.max(2, Math.round(n / 2) * 2); }

export function computeExportSize(project, tier) {
  const long = TIER_LONG[tier] || 1920;
  const pw = project.width, ph = project.height;
  const scale = long / Math.max(pw, ph);
  return { w: even(pw * scale), h: even(ph * scale) };
}

// engine: Engine configurada. opts: { tier, fps, onProgress }
export async function exportProject(engine, opts = {}) {
  const { onProgress } = opts;
  const duration = engine.duration;
  if (duration <= 0) throw new Error('El proyecto está vacío.');

  const tier = opts.tier || 1080;
  const fps = opts.fps || engine.project.fps || 30;
  const { w, h } = computeExportSize(engine.project, tier);

  getAudioContext();
  const exportCanvas = engine.beginExport(w, h);

  // Captura manual (requestFrame) cuando está disponible: garantiza un
  // fotograma codificado por cada render, incluso si el equipo es lento a 4K.
  let videoStream = exportCanvas.captureStream(0);
  let vtrack = videoStream.getVideoTracks()[0];
  if (!vtrack || typeof vtrack.requestFrame !== 'function') {
    videoStream = exportCanvas.captureStream(fps);
    vtrack = videoStream.getVideoTracks()[0];
  } else {
    engine._captureTrack = vtrack;
  }
  const audioStream = getAudioStream();
  const tracks = [vtrack, ...audioStream.getAudioTracks()];
  const mixed = new MediaStream(tracks);

  const mimeType = pickMimeType();
  let bitrate = TIER_BITRATE[tier] || 16e6;
  if (fps >= 60) bitrate = Math.round(bitrate * 1.5);

  const recorder = new MediaRecorder(mixed, { mimeType, videoBitsPerSecond: bitrate });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    recorder.onerror = (e) => reject(e.error || new Error('Fallo al grabar'));
  });

  engine.pause();
  engine.playhead = 0;
  engine.seek(0);
  engine.render(0);
  await new Promise((r) => setTimeout(r, 150));

  recorder.start(200);

  await new Promise((resolve) => {
    const prevTick = engine.onTick;
    engine.onTick = (t, ended) => {
      if (onProgress) onProgress(Math.min(99, Math.round((t / duration) * 100)));
      if (ended) { engine.onTick = prevTick; setTimeout(resolve, 220); }
    };
    engine.play();
  });

  if (recorder.state !== 'inactive') recorder.stop();
  const blob = await done;
  engine._captureTrack = null;
  engine.endExport();
  if (onProgress) onProgress(100);

  const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  return { blob, mimeType, ext, w, h, fps };
}
