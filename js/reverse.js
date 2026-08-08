// reverse.js — Genera la versión "marcha atrás" de un clip de video.
// Recorre el video del final al principio buscando cada fotograma, lo dibuja
// en un lienzo y graba esa secuencia. Todo en el dispositivo.
//
// Limitación honesta: MediaRecorder solo captura el lienzo, así que el
// resultado NO lleva audio (por eso el clip invertido queda en silencio).

const MAX_DUR = 20;  // segundos de origen: más allá tarda demasiado en un móvil
const FPS = 15;      // suficiente para el efecto y mucho más rápido de generar

function pickMime() {
  for (const c of ['video/mp4;codecs=h264', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return 'video/webm';
}

// Busca una posición y espera a que el fotograma esté realmente listo.
function seekTo(el, t) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; el.removeEventListener('seeked', finish); resolve(); };
    el.addEventListener('seeked', finish);
    try { el.currentTime = t; } catch { finish(); }
    setTimeout(finish, 400); // seguridad: nunca nos quedamos colgados
  });
}

// blob: archivo de video original. from/to: tramo a invertir (segundos).
// onProgress: 0..1
export async function reverseVideo(blob, from, to, onProgress) {
  const dur = Math.min(MAX_DUR, Math.max(0.2, to - from));
  const url = URL.createObjectURL(blob);
  const el = document.createElement('video');
  el.src = url; el.muted = true; el.playsInline = true; el.preload = 'auto';

  try {
    await new Promise((res, rej) => {
      el.addEventListener('loadeddata', res, { once: true });
      el.addEventListener('error', () => rej(new Error('No se pudo leer el video')), { once: true });
      setTimeout(() => rej(new Error('El video tardó demasiado en abrirse')), 15000);
    });

    const w = el.videoWidth || 640, h = el.videoHeight || 360;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');

    // captureStream(0) + requestFrame nos deja controlar cada fotograma.
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: pickMime(), videoBitsPerSecond: 8e6 });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((res) => { rec.onstop = res; });
    rec.start();

    const total = Math.max(2, Math.round(dur * FPS));
    const step = dur / total;
    for (let i = 0; i < total; i++) {
      // Del final hacia el principio: eso es la marcha atrás.
      const t = Math.max(0, from + dur - i * step);
      await seekTo(el, t);
      ctx.drawImage(el, 0, 0, w, h);
      if (track.requestFrame) track.requestFrame();
      if (onProgress) onProgress(i / total);
      // Cede el hilo para que la interfaz siga respondiendo.
      if (i % 4 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    if (onProgress) onProgress(1);
    // Deja respirar al codificador antes de cerrar.
    await new Promise((r) => setTimeout(r, 220));
    rec.stop();
    await stopped;
    track.stop();

    const out = new Blob(chunks, { type: chunks[0] ? chunks[0].type : 'video/webm' });
    if (!out.size) throw new Error('No se pudo generar el video invertido');
    return { blob: out, duration: dur, width: w, height: h };
  } finally {
    try { el.pause(); el.removeAttribute('src'); el.load(); } catch {}
    URL.revokeObjectURL(url);
  }
}

export const REVERSE_MAX_DUR = MAX_DUR;
