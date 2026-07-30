// exporter.js — Exporta el proyecto a un archivo de video en el propio
// dispositivo, grabando el canvas + el audio mezclado con MediaRecorder.
// No se sube nada a ningún servidor.

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

// engine: instancia de Engine ya configurada con el proyecto.
// opts: { onProgress(percent), quality }
export async function exportProject(engine, opts = {}) {
  const { onProgress } = opts;
  const duration = engine.duration;
  if (duration <= 0) throw new Error('El proyecto está vacío.');

  getAudioContext(); // asegura contexto activo
  const fps = engine.project.fps || 30;
  const videoStream = engine.canvas.captureStream(fps);
  const audioStream = getAudioStream();

  const tracks = [...videoStream.getVideoTracks(), ...audioStream.getAudioTracks()];
  const mixed = new MediaStream(tracks);

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(mixed, {
    mimeType,
    videoBitsPerSecond: opts.quality === 720 ? 6_000_000 : 10_000_000,
  });

  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

  const done = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    recorder.onerror = (e) => reject(e.error || new Error('Fallo al grabar'));
  });

  // Reinicia y reproduce la timeline completa en tiempo real mientras graba.
  engine.pause();
  engine.seek(0);
  engine.playhead = 0;
  await new Promise((r) => setTimeout(r, 120)); // deja que el primer frame se dibuje

  recorder.start(200);

  await new Promise((resolve) => {
    const prevTick = engine.onTick;
    engine.onTick = (t, ended) => {
      if (onProgress) onProgress(Math.min(100, Math.round((t / duration) * 100)));
      if (ended) {
        engine.onTick = prevTick;
        // deja un pequeño margen para capturar el último frame
        setTimeout(() => resolve(), 200);
      }
    };
    engine.play();
  });

  if (recorder.state !== 'inactive') recorder.stop();
  const blob = await done;
  if (onProgress) onProgress(100);

  const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  return { blob, mimeType, ext };
}
