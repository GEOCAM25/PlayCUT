// pro.js — Gestión de las funciones PRO.
// El desbloqueo se guarda SOLO en este dispositivo (como todo lo demás).
// Los códigos se comprueban con un hash, así no aparecen en claro en el código.

const PRO_KEY = 'playcut.pro';
const PRO_KEY_CODE = 'playcut.proCode';

// Lista de funciones marcadas como PRO. La clave se usa en data-pro="…".
export const PRO_FEATURES = {
  '4k': 'Exportación en 4K',
  keyframes: 'Animación con keyframes',
  chroma: 'Pantalla verde (chroma)',
  mask: 'Máscaras de forma',
  grade: 'Corrección de color avanzada',
  blend: 'Modos de mezcla',
  curves: 'Curva de velocidad',
  colorcurves: 'Curvas de color',
  stab: 'Estabilizar video',
  safe: 'Guías de encuadre',
  beat: 'Marcadores al ritmo',
  histogram: 'Histograma en vivo',
  frame: 'Exportar fotograma',
  reverse: 'Video al revés',
};

// Hash sencillo y estable (FNV-1a de 32 bits) en hexadecimal.
function proHash(str) {
  let h = 0x811c9dc5;
  const s = String(str).trim().toUpperCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Hashes de los códigos válidos. Para añadir códigos nuevos basta con meter
// aquí su hash (se obtiene con hashOf('CODIGO') desde la consola).
const VALID = new Set([
  proHash('PLAYCUT-PRO'),
  proHash('PLAYCUTPRO2026'),
  proHash('CREADOR-PRO'),
]);

export function hashOf(code) { return proHash(code); }

let unlocked = localStorage.getItem(PRO_KEY) === '1';

export function isPro() { return unlocked; }
export function proCode() { return localStorage.getItem(PRO_KEY_CODE) || ''; }

// Intenta desbloquear con un código. Devuelve true si es válido.
export function redeem(code) {
  if (!code) return false;
  if (!VALID.has(proHash(code))) return false;
  unlocked = true;
  localStorage.setItem(PRO_KEY, '1');
  localStorage.setItem(PRO_KEY_CODE, String(code).trim().toUpperCase());
  return true;
}

export function revoke() {
  unlocked = false;
  localStorage.removeItem(PRO_KEY);
  localStorage.removeItem(PRO_KEY_CODE);
}
