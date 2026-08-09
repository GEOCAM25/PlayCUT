// curves.js — Curvas de color (PRO).
//
// Una curva es una lista de puntos [x, y] en 0..1 ordenados por x. Entre los
// puntos se interpola con una spline cúbica MONÓTONA (Fritsch–Carlson): así la
// curva nunca "rebota" ni invierte el tono entre dos puntos, que es justo lo
// que se espera de una corrección de color.
//
// Todos los nombres de este módulo llevan el prefijo `crv`/`CURVE_` porque el
// build de un solo archivo mete todos los módulos en el MISMO ámbito.

export const CURVE_CHANNELS = ['rgb', 'r', 'g', 'b'];

export function crvIdentity() { return [[0, 0], [1, 1]]; }

export function crvDefault() {
  return { rgb: crvIdentity(), r: crvIdentity(), g: crvIdentity(), b: crvIdentity() };
}

function crvIsIdentity(pts) {
  if (!pts || pts.length !== 2) return false;
  return Math.abs(pts[0][0]) < 1e-4 && Math.abs(pts[0][1]) < 1e-4
    && Math.abs(pts[1][0] - 1) < 1e-4 && Math.abs(pts[1][1] - 1) < 1e-4;
}

// ¿Esta curva cambia algo? Si no, el motor se ahorra el trabajo por píxel.
export function crvActive(curves) {
  if (!curves) return false;
  for (const ch of CURVE_CHANNELS) if (!crvIsIdentity(curves[ch])) return true;
  return false;
}

// Clave estable para cachear las tablas y los fotogramas ya procesados.
export function crvKey(curves) {
  if (!curves) return '';
  return CURVE_CHANNELS.map(ch => (curves[ch] || []).map(p => p[0].toFixed(3) + ',' + p[1].toFixed(3)).join(';')).join('|');
}

// Tabla de 256 valores para un canal.
export function crvLUT(pts) {
  const lut = new Uint8Array(256);
  let p = (pts && pts.length >= 2) ? pts.slice() : crvIdentity();
  p = p.map(q => [Math.max(0, Math.min(1, q[0])), Math.max(0, Math.min(1, q[1]))]).sort((a, b) => a[0] - b[0]);
  // Dos puntos no pueden compartir la misma x (dividiría por cero).
  for (let i = 1; i < p.length; i++) if (p[i][0] - p[i - 1][0] < 1e-4) p[i][0] = Math.min(1, p[i - 1][0] + 1e-4);

  const n = p.length;
  const xs = p.map(q => q[0]), ys = p.map(q => q[1]);
  const d = new Array(n - 1), m = new Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = (d[i - 1] * d[i] <= 0) ? 0 : (d[i - 1] + d[i]) / 2;
  // Condición de monotonía: limita las pendientes al círculo de radio 3.
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }

  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let y;
    if (x <= xs[0]) y = ys[0];
    else if (x >= xs[n - 1]) y = ys[n - 1];
    else {
      let k = 0;
      while (k < n - 2 && x > xs[k + 1]) k++;
      const h = xs[k + 1] - xs[k], t = (x - xs[k]) / h, t2 = t * t, t3 = t2 * t;
      y = (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * m[k]
        + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * m[k + 1];
    }
    lut[i] = Math.max(0, Math.min(255, Math.round(y * 255)));
  }
  return lut;
}

// Devuelve las tres tablas finales: primero el canal, luego la maestra (RGB),
// igual que hacen los editores de escritorio.
export function crvTables(curves) {
  const master = crvLUT(curves && curves.rgb);
  const out = {};
  for (const ch of ['r', 'g', 'b']) {
    const own = crvLUT(curves && curves[ch]);
    const t = new Uint8Array(256);
    for (let i = 0; i < 256; i++) t[i] = master[own[i]];
    out[ch] = t;
  }
  return out;
}

// Ajustes de fábrica. Cada uno solo define los canales que toca.
export const CURVE_PRESETS = [
  { id: 'linear', nombre: 'Original', pts: {} },
  { id: 'contrast', nombre: 'Contraste S', pts: { rgb: [[0, 0], [0.25, 0.15], [0.75, 0.85], [1, 1]] } },
  { id: 'punch', nombre: 'Fuerte', pts: { rgb: [[0, 0], [0.2, 0.08], [0.8, 0.92], [1, 1]] } },
  { id: 'bright', nombre: 'Más luz', pts: { rgb: [[0, 0], [0.5, 0.63], [1, 1]] } },
  { id: 'dark', nombre: 'Más sombra', pts: { rgb: [[0, 0], [0.5, 0.37], [1, 1]] } },
  { id: 'film', nombre: 'Film fade', pts: { rgb: [[0, 0.09], [0.5, 0.52], [1, 0.95]] } },
  {
    id: 'teal', nombre: 'Cine (teal & orange)',
    pts: {
      rgb: [[0, 0], [0.25, 0.2], [0.75, 0.8], [1, 1]],
      r: [[0, 0.02], [0.5, 0.52], [1, 1]],
      b: [[0, 0.08], [0.5, 0.5], [1, 0.93]],
    },
  },
  {
    id: 'warm', nombre: 'Atardecer',
    pts: { r: [[0, 0.04], [0.5, 0.57], [1, 1]], b: [[0, 0], [0.5, 0.44], [1, 0.95]] },
  },
  {
    id: 'cold', nombre: 'Noche fría',
    pts: { r: [[0, 0], [0.5, 0.45], [1, 0.96]], b: [[0, 0.05], [0.5, 0.57], [1, 1]] },
  },
  {
    id: 'crossp', nombre: 'Cross process',
    pts: {
      r: [[0, 0], [0.3, 0.22], [0.7, 0.8], [1, 1]],
      g: [[0, 0.03], [0.5, 0.5], [1, 0.98]],
      b: [[0, 0.12], [0.5, 0.48], [1, 0.88]],
    },
  },
];

export function crvFromPreset(id) {
  const p = CURVE_PRESETS.find(x => x.id === id);
  const c = crvDefault();
  if (!p) return c;
  for (const ch of CURVE_CHANNELS) if (p.pts[ch]) c[ch] = p.pts[ch].map(q => q.slice());
  return c;
}
