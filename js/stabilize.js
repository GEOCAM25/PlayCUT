// stabilize.js — Estabilización de video temblado (PRO).
//
// Cómo funciona, en corto:
//  1. Reproduce el clip y captura CADA fotograma (requestVideoFrameCallback),
//     reduciéndolo a una miniatura en blanco y negro. Hay que ir fotograma a
//     fotograma: un temblor de cámara llega a 8-10 sacudidas por segundo y
//     muestreando más despacio ni siquiera se ve.
//  2. Mide cuánto se ha movido cada fotograma respecto al anterior buscando el
//     desplazamiento que menos diferencia deja (SAD), y afina el resultado por
//     debajo del píxel con una parábola: el temblor típico es de 1 o 2 píxeles
//     en la miniatura, así que sin subpíxel no se corrige nada.
//  3. Acumula esos movimientos para reconstruir la trayectoria real de la
//     cámara y la suaviza con una gaussiana. Lo que sobra —la diferencia entre
//     la trayectoria real y la suave— es justo el temblor a compensar.
//  4. Guarda la compensación de CADA fotograma junto a su tiempo, y calcula el
//     zoom mínimo que tapa los bordes que quedan al mover la imagen.
//
// Nada de esto sale del dispositivo: es el mismo video, leído en local.
//
// Prefijo `stb`/`STB_` en todo lo de arriba: el build de un solo archivo
// junta todos los módulos en el mismo ámbito.

const STB_MAX_DUR = 20;   // segundos analizados como máximo
const STB_W = 96;         // ancho del análisis en píxeles
const STB_RANGE = 5;      // desplazamiento máximo buscado, en píxeles de análisis
const STB_SMOOTH = 0.45;  // ventana de suavizado, en segundos

export const STAB_MAX_DUR = STB_MAX_DUR;

// Diferencia media entre dos miniaturas con la segunda desplazada (dx, dy).
// Solo compara la zona central, que es la que existe en ambas.
function stbSAD(a, b, w, h, dx, dy, borde) {
  let suma = 0, n = 0;
  for (let y = borde; y < h - borde; y++) {
    const yb = y + dy;
    if (yb < 0 || yb >= h) continue;
    const filaA = y * w, filaB = yb * w;
    for (let x = borde; x < w - borde; x++) {
      const xb = x + dx;
      if (xb < 0 || xb >= w) continue;
      const d = a[filaA + x] - b[filaB + xb];
      suma += d < 0 ? -d : d;
      n++;
    }
  }
  return n ? suma / n : 1e9;
}

// Vértice de la parábola que pasa por tres errores seguidos. Da la posición
// real con precisión de fracción de píxel.
function stbSub(e0, e1, e2) {
  const den = e0 - 2 * e1 + e2;
  if (Math.abs(den) < 1e-6) return 0;
  const d = 0.5 * (e0 - e2) / den;
  return Math.max(-1, Math.min(1, d));
}

// Busca el desplazamiento entre dos miniaturas, con precisión de subpíxel.
function stbMatch(a, b, w, h) {
  const borde = Math.max(2, Math.round(Math.min(w, h) * 0.15));
  let mejor = { dx: 0, dy: 0, err: Infinity };
  for (let dy = -STB_RANGE; dy <= STB_RANGE; dy++) {
    for (let dx = -STB_RANGE; dx <= STB_RANGE; dx++) {
      const err = stbSAD(a, b, w, h, dx, dy, borde);
      if (err < mejor.err) mejor = { dx, dy, err };
    }
  }
  const { dx, dy, err } = mejor;
  let sx = 0, sy = 0;
  if (Math.abs(dx) < STB_RANGE) {
    sx = stbSub(stbSAD(a, b, w, h, dx - 1, dy, borde), err, stbSAD(a, b, w, h, dx + 1, dy, borde));
  }
  if (Math.abs(dy) < STB_RANGE) {
    sy = stbSub(stbSAD(a, b, w, h, dx, dy - 1, borde), err, stbSAD(a, b, w, h, dx, dy + 1, borde));
  }
  return { dx: dx + sx, dy: dy + sy };
}

// Suavizado gaussiano de una serie (la trayectoria de la cámara).
function stbSmooth(serie, sigma) {
  const n = serie.length;
  const radio = Math.max(1, Math.round(sigma * 2.5));
  const peso = [];
  for (let i = -radio; i <= radio; i++) peso.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, w = 0;
    for (let k = -radio; k <= radio; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      const p = peso[k + radio];
      s += serie[j] * p; w += p;
    }
    out[i] = w ? s / w : serie[i];
  }
  return out;
}

// Recorre el clip capturando cada fotograma decodificado. Devuelve
// { tiempos[], grises[] }. Usa requestVideoFrameCallback si existe (Chrome,
// Safari) y si no, busca posición a posición.
async function stbCapturar(el, from, to, w, h, onProgress) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const tiempos = [], grises = [];
  const dur = to - from;

  const tomar = (t) => {
    cx.drawImage(el, 0, 0, w, h);
    const img = cx.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    for (let p = 0, q = 0; p < img.length; p += 4, q++) {
      g[q] = 0.299 * img[p] + 0.587 * img[p + 1] + 0.114 * img[p + 2];
    }
    tiempos.push(t); grises.push(g);
    if (onProgress) onProgress(Math.max(0, Math.min(1, (t - from) / dur)));
  };

  if (typeof el.requestVideoFrameCallback === 'function') {
    el.currentTime = from;
    await new Promise((r) => { el.addEventListener('seeked', r, { once: true }); setTimeout(r, 1500); });
    await new Promise((resolve) => {
      let parado = false;
      const fin = () => { if (parado) return; parado = true; try { el.pause(); } catch {} resolve(); };
      const paso = (_now, meta) => {
        if (parado) return;
        const t = meta.mediaTime;
        if (t > to + 0.001) { fin(); return; }
        tomar(t);
        el.requestVideoFrameCallback(paso);
      };
      el.addEventListener('ended', fin, { once: true });
      el.requestVideoFrameCallback(paso);
      el.play().catch(fin);
      setTimeout(fin, (dur + 6) * 1000); // seguridad
    });
  } else {
    const pasos = Math.max(4, Math.round(dur * 25));
    const step = dur / pasos;
    for (let i = 0; i < pasos; i++) {
      const t = from + i * step;
      await new Promise((r) => {
        let listo = false;
        const fin = () => { if (listo) return; listo = true; el.removeEventListener('seeked', fin); r(); };
        el.addEventListener('seeked', fin);
        try { el.currentTime = t; } catch { fin(); }
        setTimeout(fin, 400);
      });
      tomar(t);
      if (i % 3 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  }
  return { tiempos, grises };
}

// blob: el video original. from/to: tramo del clip a analizar (segundos del
// archivo). onProgress: 0..1. Devuelve los datos listos para guardar en el clip.
export async function analyzeShake(blob, from, to, onProgress) {
  const dur = Math.min(STB_MAX_DUR, Math.max(0.4, to - from));
  const hasta = from + dur;
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
    const w = STB_W, h = Math.max(8, Math.round(STB_W * vh / vw));

    const { tiempos, grises } = await stbCapturar(el, from, hasta, w, h, onProgress);
    if (tiempos.length < 4) throw new Error('El video es demasiado corto para analizarlo');
    if (onProgress) onProgress(1);

    // Trayectoria real de la cámara, fotograma a fotograma.
    const n = tiempos.length;
    const trayX = new Float32Array(n), trayY = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      const m = stbMatch(grises[i - 1], grises[i], w, h);
      trayX[i] = trayX[i - 1] + m.dx;
      trayY[i] = trayY[i - 1] + m.dy;
      if (i % 24 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    // Suaviza en muestras equivalentes a STB_SMOOTH segundos.
    const fps = Math.max(6, (n - 1) / Math.max(0.001, tiempos[n - 1] - tiempos[0]));
    const suaveX = stbSmooth(trayX, Math.max(2, STB_SMOOTH * fps));
    const suaveY = stbSmooth(trayY, Math.max(2, STB_SMOOTH * fps));

    // Compensación por fotograma, en fracción de encuadre.
    const compX = new Float32Array(n), compY = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      compX[i] = (suaveX[i] - trayX[i]) / w;
      compY[i] = (suaveY[i] - trayY[i]) / h;
    }

    // Se guarda un punto POR FOTOGRAMA, con su tiempo real. Nada de rejillas
    // interpoladas: al reproducir se ve un fotograma concreto, y la corrección
    // tiene que ser exactamente la suya. Interpolar entre dos fotogramas
    // vecinos rebaja el temblor a la mitad y lo desfasa — o sea, no corrige.
    const pts = [];
    let maxX = 0, maxY = 0;
    for (let i = 0; i < n; i++) {
      const cx = compX[i], cy = compY[i];
      if (Math.abs(cx) > maxX) maxX = Math.abs(cx);
      if (Math.abs(cy) > maxY) maxY = Math.abs(cy);
      pts.push([+tiempos[i].toFixed(3), +cx.toFixed(4), +cy.toFixed(4)]);
    }
    // Zoom mínimo para que el movimiento no descubra los bordes.
    const zoom = Math.min(1.3, Math.max(1.005, 1 + 2.1 * Math.max(maxX, maxY)));

    return {
      on: true, strength: 1, zoom: +zoom.toFixed(3),
      from, pts,
      frames: n, fps: +fps.toFixed(1),
      shake: +(Math.max(maxX, maxY) * 100).toFixed(1), // cuánto temblaba, en %
    };
  } finally {
    try { el.pause(); el.removeAttribute('src'); el.load(); } catch {}
    URL.revokeObjectURL(url);
  }
}
