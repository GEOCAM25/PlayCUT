// autocut.js — Corte automático: por silencios y por cambio de plano.
//
// Dos análisis distintos, los dos en el dispositivo:
//
//  · SILENCIOS: descodifica el audio del clip y calcula su energía (RMS) en
//    ventanas cortas. El umbral no es fijo, se saca del propio audio: se toma
//    el nivel de la voz (percentil alto) y se corta muy por debajo de él, así
//    funciona igual con una grabación bajita que con una fuerte.
//
//  · CAMBIOS DE PLANO: recorre los fotogramas y compara el HISTOGRAMA de cada
//    uno con el del anterior. El histograma no se inmuta por el movimiento de
//    cámara (que cambia los píxeles de sitio pero no los colores) y en cambio
//    se dispara cuando la imagen entera cambia, que es justo un corte.
//
// Prefijo `ac`/`AC_`: el build de un solo archivo junta todo en un ámbito.

const AC_VENTANA = 0.02;   // segundos por ventana de análisis de audio
const AC_ESCENA_W = 64;    // ancho del análisis de imagen

// ---------------------------------------------------------------- SILENCIOS

// Devuelve los tramos SILENCIOSOS de un audio, en segundos del archivo.
// opts: { sensibilidad 0..100, minSilencio, margen }
export async function detectSilences(blob, opts = {}) {
  const sens = Math.max(0, Math.min(100, opts.sensibilidad ?? 50));
  const minSilencio = opts.minSilencio ?? 0.35;
  const margen = opts.margen ?? 0.08;

  const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100, 44100);
  let buffer;
  try {
    const arr = await blob.arrayBuffer();
    buffer = await new Promise((res, rej) => {
      const p = ctx.decodeAudioData(arr, res, rej);
      if (p && p.then) p.then(res, rej);
    });
  } catch (e) {
    throw new Error('Este archivo no trae audio que se pueda analizar');
  }
  const sr = buffer.sampleRate;
  const datos = buffer.getChannelData(0);
  const paso = Math.max(1, Math.round(sr * AC_VENTANA));
  const n = Math.floor(datos.length / paso);
  if (n < 4) throw new Error('El audio es demasiado corto');

  // Energía por ventana.
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const a = i * paso, b = a + paso;
    for (let k = a; k < b; k++) s += datos[k] * datos[k];
    rms[i] = Math.sqrt(s / paso);
  }

  // Umbral relativo al propio audio: percentil 90 = «esto es voz».
  const orden = Float32Array.from(rms).sort();
  const alto = orden[Math.floor(n * 0.9)] || 1e-6;
  const suelo = orden[Math.floor(n * 0.1)] || 0;
  // A más sensibilidad, corta más cerca del nivel de la voz.
  const factor = 0.06 + (sens / 100) * 0.34;
  const umbral = Math.max(suelo * 1.6, alto * factor);

  // Tramos por debajo del umbral y más largos que minSilencio.
  const silencios = [];
  let inicio = -1;
  for (let i = 0; i < n; i++) {
    const callado = rms[i] < umbral;
    if (callado && inicio < 0) inicio = i;
    if ((!callado || i === n - 1) && inicio >= 0) {
      const fin = (callado ? i + 1 : i);
      const t0 = inicio * AC_VENTANA, t1 = fin * AC_VENTANA;
      if (t1 - t0 >= minSilencio) {
        // Deja un margen a cada lado para no comerse el principio ni el final
        // de las palabras (cortar «al ras» suena fatal).
        const a = t0 + margen, b = t1 - margen;
        if (b - a > 0.05) silencios.push({ from: a, to: b });
      }
      inicio = -1;
    }
  }
  return { silencios, duracion: buffer.duration, umbral, nivelVoz: alto };
}

// A partir de los silencios, los tramos que HAY QUE CONSERVAR dentro de
// [from, to] del archivo original.
export function keepRanges(silencios, from, to, minTrozo = 0.25) {
  const dentro = silencios
    .map(s => ({ from: Math.max(from, s.from), to: Math.min(to, s.to) }))
    .filter(s => s.to - s.from > 0.02)
    .sort((a, b) => a.from - b.from);
  const trozos = [];
  let cursor = from;
  for (const s of dentro) {
    if (s.from - cursor >= minTrozo) trozos.push({ from: cursor, to: s.from });
    cursor = Math.max(cursor, s.to);
  }
  if (to - cursor >= minTrozo) trozos.push({ from: cursor, to });
  return trozos;
}

// ------------------------------------------------------------ CAMBIOS DE PLANO

function acHistograma(datos, w, h) {
  // 4×4×4 = 64 cubos de color. Suficiente para distinguir planos y muy barato.
  const hist = new Float32Array(64);
  for (let i = 0; i < datos.length; i += 4) {
    const r = datos[i] >> 6, g = datos[i + 1] >> 6, b = datos[i + 2] >> 6;
    hist[r * 16 + g * 4 + b]++;
  }
  const total = (w * h) || 1;
  for (let i = 0; i < 64; i++) hist[i] /= total;
  return hist;
}

function acDistancia(a, b) {
  let d = 0;
  for (let i = 0; i < 64; i++) d += Math.abs(a[i] - b[i]);
  return d / 2; // 0 = idénticos, 1 = nada en común
}

// Devuelve los instantes (segundos del archivo) donde cambia el plano.
// sensibilidad 0..100: a más alto, detecta cortes más sutiles.
export async function detectScenes(blob, from, to, sensibilidad = 50, onProgress) {
  const url = URL.createObjectURL(blob);
  const el = document.createElement('video');
  el.src = url; el.muted = true; el.playsInline = true; el.preload = 'auto';
  try {
    await new Promise((res, rej) => {
      el.addEventListener('loadeddata', res, { once: true });
      el.addEventListener('error', () => rej(new Error('No se pudo leer el video')), { once: true });
      setTimeout(() => rej(new Error('El video tardó demasiado en abrirse')), 15000);
    });
    const vw = el.videoWidth || 640, vh = el.videoHeight || 360;
    const w = AC_ESCENA_W, h = Math.max(8, Math.round(AC_ESCENA_W * vh / vw));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const cx = cv.getContext('2d', { willReadFrequently: true });

    // Muestreo a 8 fps: un corte dura 0 s, así que no hace falta ir fotograma
    // a fotograma como en la estabilización; basta con mirar a menudo.
    const dur = Math.max(0.5, to - from);
    const fps = 8;
    const total = Math.max(3, Math.round(dur * fps));
    const paso = dur / total;
    const dist = [], tiempos = [];
    let prev = null;

    for (let i = 0; i < total; i++) {
      const t = from + i * paso;
      await new Promise((r) => {
        let listo = false;
        const fin = () => { if (listo) return; listo = true; el.removeEventListener('seeked', fin); r(); };
        el.addEventListener('seeked', fin);
        try { el.currentTime = t; } catch { fin(); }
        setTimeout(fin, 400);
      });
      cx.drawImage(el, 0, 0, w, h);
      const hist = acHistograma(cx.getImageData(0, 0, w, h).data, w, h);
      if (prev) { dist.push(acDistancia(prev, hist)); tiempos.push(t); }
      prev = hist;
      if (onProgress) onProgress(i / total);
      if (i % 3 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    if (onProgress) onProgress(1);
    if (dist.length < 3) return [];

    // Umbral: la mediana de los cambios normales más un margen. Así un video
    // movido (donde todo cambia un poco) no se llena de cortes falsos.
    const orden = dist.slice().sort((a, b) => a - b);
    const mediana = orden[Math.floor(orden.length / 2)];
    const p90 = orden[Math.floor(orden.length * 0.9)];
    const k = 2.6 - (sensibilidad / 100) * 1.6;   // 2.6 (estricto) … 1.0 (sensible)
    const umbral = Math.max(0.12, mediana + Math.max(0.05, p90 - mediana) * k);

    const cortes = [];
    for (let i = 0; i < dist.length; i++) {
      if (dist[i] < umbral) continue;
      const t = tiempos[i];
      // No amontones cortes: al menos medio segundo entre uno y otro.
      if (cortes.length && t - cortes[cortes.length - 1] < 0.5) continue;
      if (t - from < 0.4 || to - t < 0.4) continue;
      cortes.push(t);
    }
    return cortes;
  } finally {
    try { el.pause(); el.removeAttribute('src'); el.load(); } catch {}
    URL.revokeObjectURL(url);
  }
}
