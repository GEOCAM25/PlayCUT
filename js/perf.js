// perf.js — Detección de capacidades del dispositivo y ajuste adaptativo.
// La app se adapta a cada equipo: en gama alta usa máxima resolución/fps de
// vista previa; en gama baja reduce el trabajo para ir siempre fluida.
// La EXPORTACIÓN siempre usa la resolución elegida por el usuario.

const KEY = 'playcut.perf';

function detectTier() {
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4; // GB (aprox, solo Chrome)
  const dpr = window.devicePixelRatio || 1;
  const big = Math.max(screen.width, screen.height) * dpr;
  let score = 0;
  score += cores >= 8 ? 2 : cores >= 6 ? 1 : cores <= 3 ? -1 : 0;
  score += mem >= 8 ? 2 : mem >= 4 ? 1 : mem <= 2 ? -2 : 0;
  score += big >= 2200 ? 1 : big <= 900 ? -1 : 0;
  if (score >= 3) return 'high';
  if (score <= -1) return 'low';
  return 'mid';
}

const TIERS = {
  high: { previewScale: 1.0, targetFps: 60, label: 'Alta' },
  mid:  { previewScale: 0.85, targetFps: 45, label: 'Equilibrada' },
  low:  { previewScale: 0.6, targetFps: 30, label: 'Ahorro' },
};

// Modo elegido por el usuario: 'auto' | 'high' | 'mid' | 'low'
let mode = localStorage.getItem(KEY) || 'auto';
let detected = detectTier();

export function getMode() { return mode; }
export function setMode(m) { mode = m; localStorage.setItem(KEY, m); }
export function getDetectedTier() { return detected; }

function effectiveTier() { return mode === 'auto' ? detected : mode; }

export function getProfile() {
  return TIERS[effectiveTier()] || TIERS.mid;
}

// Sugerencia de resolución de exportación por defecto según el equipo.
export function suggestedExportTier() {
  const t = effectiveTier();
  return t === 'high' ? 2160 : t === 'mid' ? 1080 : 720;
}

export function deviceSummary() {
  const cores = navigator.hardwareConcurrency || '?';
  const mem = navigator.deviceMemory ? navigator.deviceMemory + ' GB' : 'n/d';
  return `${cores} núcleos · ${mem} · ${effectiveTier().toUpperCase()}`;
}
