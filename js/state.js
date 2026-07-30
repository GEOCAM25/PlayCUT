// state.js — Modelo de datos del proyecto y utilidades.
// v2: transiciones (solapamiento real), velocidad, transformaciones,
// movimiento (Ken Burns), fundidos de audio y textos/stickers avanzados.

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Presets de formato (relación de aspecto).
export const RATIOS = {
  '9:16': [1080, 1920],
  '1:1':  [1080, 1080],
  '16:9': [1920, 1080],
  '4:5':  [1080, 1350],
  '3:4':  [1080, 1440],
  '21:9': [1920, 823],
};

export function createProject(name = 'Proyecto sin título') {
  const [w, h] = RATIOS['9:16'];
  return {
    id: uid(),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ratio: '9:16',
    width: w,
    height: h,
    fps: 30,
    thumb: null,
    bgColor: '#000000',
    tracks: { video: [], overlay: [], audio: [], text: [] },
  };
}

// ---------------- Fábricas de clips ----------------
export function createVideoClip({ mediaId, type, duration, width, height }) {
  return {
    id: uid(),
    mediaId,
    type,               // 'video' | 'image'
    inPoint: 0,
    outPoint: duration,
    imageDuration: 3,
    srcWidth: width,
    srcHeight: height,
    srcDuration: duration,
    // audio
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    // color
    brightness: 1, contrast: 1, saturation: 1, opacity: 1, filter: 'none',
    // movimiento / velocidad
    speed: 1,
    motion: 'none',     // none | zoomIn | zoomOut | panL | panR | panU | panD
    // encuadre
    fillMode: 'contain', // contain | cover
    bg: 'blur',          // black | blur
    scale: 1, offsetX: 0, offsetY: 0, rotate: 0,
    // transición con el clip anterior
    transition: { type: 'none', duration: 0.6 },
  };
}

// Capa superpuesta (Picture-in-Picture): video o imagen encima del principal,
// posicionado libremente en el tiempo (start) y en pantalla (scale/offset).
export function createOverlayClip({ mediaId, type, duration, width, height, start = 0 }) {
  return {
    id: uid(), mediaId, type,
    start,
    inPoint: 0, outPoint: duration, imageDuration: 3,
    srcWidth: width, srcHeight: height, srcDuration: duration,
    volume: 1, fadeIn: 0, fadeOut: 0,
    brightness: 1, contrast: 1, saturation: 1, opacity: 1, filter: 'none',
    speed: 1, motion: 'none',
    fillMode: 'contain',
    scale: 0.42, offsetX: 0.26, offsetY: -0.28, rotate: 0,
    radius: 0.04, shadow: true,
  };
}

export function overlayDuration(clip) {
  if (clip.type === 'image') return Math.max(0.1, clip.imageDuration);
  return Math.max(0.05, (clip.outPoint - clip.inPoint) / (clip.speed || 1));
}

export function createAudioClip({ mediaId, duration, start = 0, name = 'Audio' }) {
  return {
    id: uid(), mediaId, type: 'audio', name,
    inPoint: 0, outPoint: duration, srcDuration: duration,
    start, volume: 1, fadeIn: 0, fadeOut: 0,
  };
}

export function createTextClip({ text = 'Texto', start = 0, end = 3, sticker = false }) {
  return {
    id: uid(), type: 'text', text,
    start, end,
    x: 0.5, y: sticker ? 0.5 : 0.8,
    size: sticker ? 140 : 64,
    color: '#ffffff',
    stroke: !sticker,
    bold: true,
    font: 'sans',        // sans | serif | round | mono | display
    bg: 'none',          // none | black | white | color
    bgColor: '#ff3b6b',
    animIn: 'none',      // none | fade | pop | slideup | slidedown
    animOut: 'none',
    rotate: 0,
    isSticker: sticker,
  };
}

// Rellena valores por defecto en proyectos antiguos (compatibilidad).
export function normalizeProject(p) {
  if (!p.ratio) { p.ratio = '9:16'; }
  if (!p.width || !p.height) { const [w, h] = RATIOS[p.ratio] || RATIOS['9:16']; p.width = w; p.height = h; }
  if (!p.fps) p.fps = 30;
  if (!p.bgColor) p.bgColor = '#000000';
  p.tracks = p.tracks || { video: [], overlay: [], audio: [], text: [] };
  if (!p.tracks.overlay) p.tracks.overlay = [];
  for (const c of p.tracks.video) {
    c.speed = c.speed || 1;
    c.motion = c.motion || 'none';
    c.fillMode = c.fillMode || 'contain';
    c.bg = c.bg || 'blur';
    c.scale = c.scale ?? 1; c.offsetX = c.offsetX ?? 0; c.offsetY = c.offsetY ?? 0; c.rotate = c.rotate ?? 0;
    c.fadeIn = c.fadeIn ?? 0; c.fadeOut = c.fadeOut ?? 0;
    if (!c.transition) c.transition = { type: 'none', duration: 0.6 };
  }
  for (const c of p.tracks.overlay) {
    c.speed = c.speed || 1; c.motion = c.motion || 'none'; c.fillMode = c.fillMode || 'contain';
    c.scale = c.scale ?? 0.42; c.offsetX = c.offsetX ?? 0.26; c.offsetY = c.offsetY ?? -0.28;
    c.rotate = c.rotate ?? 0; c.opacity = c.opacity ?? 1; c.filter = c.filter || 'none';
    c.brightness = c.brightness ?? 1; c.contrast = c.contrast ?? 1; c.saturation = c.saturation ?? 1;
    c.volume = c.volume ?? 1; c.fadeIn = c.fadeIn ?? 0; c.fadeOut = c.fadeOut ?? 0;
    c.radius = c.radius ?? 0.04; c.shadow = c.shadow ?? true; c.start = c.start ?? 0;
  }
  for (const c of p.tracks.audio) { c.fadeIn = c.fadeIn ?? 0; c.fadeOut = c.fadeOut ?? 0; }
  for (const c of p.tracks.text) {
    c.bold = c.bold ?? true; c.font = c.font || 'sans'; c.bg = c.bg || 'none';
    c.bgColor = c.bgColor || '#ff3b6b'; c.animIn = c.animIn || 'none';
    c.animOut = c.animOut || 'none'; c.rotate = c.rotate ?? 0; c.isSticker = c.isSticker ?? false;
  }
  return p;
}

// ---------------- Duraciones ----------------
export function clipDuration(clip) {
  if (clip.type === 'image') return Math.max(0.1, clip.imageDuration);
  return Math.max(0.05, (clip.outPoint - clip.inPoint) / (clip.speed || 1));
}

// Solapamiento (transición) del clip i con el anterior.
export function transitionOverlap(clips, i) {
  if (i <= 0) return 0;
  const tr = clips[i].transition;
  if (!tr || tr.type === 'none' || !tr.duration) return 0;
  const prevDur = clipDuration(clips[i - 1]);
  const curDur = clipDuration(clips[i]);
  return Math.min(tr.duration, prevDur * 0.9, curDur * 0.9);
}

// Distribución absoluta de la pista de video teniendo en cuenta transiciones.
export function videoLayout(clips) {
  const layout = [];
  let prevEnd = 0;
  for (let i = 0; i < clips.length; i++) {
    const dur = clipDuration(clips[i]);
    const D = transitionOverlap(clips, i);
    const start = i === 0 ? 0 : prevEnd - D;
    const end = start + dur;
    layout.push({ clip: clips[i], index: i, start, end, dur, overlapPrev: D });
    prevEnd = end;
  }
  return layout;
}

export function videoClipStart(clips, index) {
  const layout = videoLayout(clips);
  return layout[index] ? layout[index].start : 0;
}

export function videoTotalDuration(clips) {
  const layout = videoLayout(clips);
  return layout.length ? layout[layout.length - 1].end : 0;
}

export function projectDuration(project) {
  const vid = videoTotalDuration(project.tracks.video);
  let audioEnd = 0;
  for (const a of project.tracks.audio) audioEnd = Math.max(audioEnd, a.start + (a.outPoint - a.inPoint));
  let textEnd = 0;
  for (const t of project.tracks.text) textEnd = Math.max(textEnd, t.end);
  let ovEnd = 0;
  for (const o of (project.tracks.overlay || [])) ovEnd = Math.max(ovEnd, o.start + overlayDuration(o));
  return Math.max(vid, audioEnd, textEnd, ovEnd, 0);
}

function srcTimeOf(clip, local) {
  return clip.type === 'video' ? clip.inPoint + local * (clip.speed || 1) : 0;
}

// Devuelve los clips activos en t. Durante una transición hay dos (a y b).
// { a, b, p, localA, localB, srcA, srcB, index }
export function videoStateAt(clips, t) {
  const layout = videoLayout(clips);
  const hits = layout.filter(l => t >= l.start - 1e-6 && t < l.end - 1e-6);
  if (hits.length === 0) return null;
  if (hits.length === 1) {
    const l = hits[0];
    const localA = t - l.start;
    return { a: l.clip, b: null, p: 0, localA, localB: 0, srcA: srcTimeOf(l.clip, localA), srcB: 0, index: l.index };
  }
  // Solapamiento entre l0 (anterior) y l1 (actual).
  const [l0, l1] = hits.slice(-2);
  const D = l1.overlapPrev || (l0.end - l1.start);
  const p = D > 0 ? Math.min(1, Math.max(0, (t - l1.start) / D)) : 1;
  const localA = t - l0.start, localB = t - l1.start;
  return {
    a: l0.clip, b: l1.clip, p,
    localA, localB,
    srcA: srcTimeOf(l0.clip, localA), srcB: srcTimeOf(l1.clip, localB),
    index: l1.index, type: l1.clip.transition?.type || 'dissolve',
  };
}

// Compatibilidad: clip único activo (para dividir, etc.)
export function videoClipAt(clips, t) {
  const layout = videoLayout(clips);
  for (const l of layout) {
    if (t >= l.start - 1e-6 && t < l.end - 1e-6) {
      const local = t - l.start;
      return { clip: l.clip, index: l.index, localTime: local, srcTime: srcTimeOf(l.clip, local), start: l.start };
    }
  }
  return null;
}

// ---------------- Formato / filtros ----------------
export function formatTime(sec) {
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const d = Math.floor((sec * 10) % 10);
  return `${m}:${String(s).padStart(2, '0')}.${d}`;
}

export function clipFilterString(clip) {
  let f = `brightness(${clip.brightness}) contrast(${clip.contrast}) saturate(${clip.saturation})`;
  switch (clip.filter) {
    case 'bw': f += ' grayscale(1)'; break;
    case 'warm': f += ' sepia(.35) saturate(1.3) hue-rotate(-10deg)'; break;
    case 'cool': f += ' saturate(1.1) hue-rotate(20deg) brightness(1.03)'; break;
    case 'vivid': f += ' saturate(1.6) contrast(1.15)'; break;
    case 'vintage': f += ' sepia(.5) contrast(.9) brightness(1.05) saturate(.85)'; break;
    case 'cine': f += ' contrast(1.1) saturate(.85) sepia(.15) hue-rotate(-8deg)'; break;
    case 'fade': f += ' contrast(.85) brightness(1.1) saturate(.8)'; break;
    case 'noir': f += ' grayscale(1) contrast(1.3) brightness(.95)'; break;
    case 'neon': f += ' saturate(2) contrast(1.2) hue-rotate(-15deg)'; break;
  }
  return f;
}

export const FONTS = {
  sans: '-apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  round: '"Trebuchet MS", "Segoe UI", system-ui, sans-serif',
  mono: '"Courier New", monospace',
  display: 'Impact, "Arial Black", sans-serif',
};
