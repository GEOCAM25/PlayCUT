// state.js — Modelo de datos del proyecto y utilidades.

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function createProject(name = 'Proyecto sin título') {
  return {
    id: uid(),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    width: 1080,
    height: 1920,
    fps: 30,
    thumb: null, // dataURL de portada
    tracks: {
      video: [], // clips de video/imagen, secuenciales
      audio: [], // clips de audio, con start absoluto
      text: [],  // overlays de texto, con start/end absolutos
    },
  };
}

// Clip de video o imagen. Los clips de video/imagen van secuenciales en la pista.
export function createVideoClip({ mediaId, type, duration, width, height }) {
  return {
    id: uid(),
    mediaId,
    type,               // 'video' | 'image'
    inPoint: 0,         // seg dentro del origen (solo video)
    outPoint: duration, // seg dentro del origen (solo video)
    imageDuration: 3,   // seg en timeline (solo imagen)
    srcWidth: width,
    srcHeight: height,
    srcDuration: duration,
    volume: 1,
    brightness: 1,
    contrast: 1,
    saturation: 1,
    opacity: 1,
    filter: 'none',
  };
}

export function createAudioClip({ mediaId, duration, start = 0 }) {
  return {
    id: uid(),
    mediaId,
    type: 'audio',
    inPoint: 0,
    outPoint: duration,
    srcDuration: duration,
    start,       // posición en la timeline (seg)
    volume: 1,
  };
}

export function createTextClip({ text = 'Texto', start = 0, end = 3 }) {
  return {
    id: uid(),
    type: 'text',
    text,
    start,
    end,
    x: 0.5,      // 0..1 horizontal (centro)
    y: 0.8,      // 0..1 vertical
    size: 64,    // px relativo a alto de 1920
    color: '#ffffff',
    stroke: true,
  };
}

// Duración efectiva de un clip de video/imagen en la timeline.
export function clipDuration(clip) {
  if (clip.type === 'image') return clip.imageDuration;
  return Math.max(0.05, clip.outPoint - clip.inPoint);
}

// Calcula el inicio absoluto (seg) de cada clip de video en la pista.
export function videoClipStart(clips, index) {
  let t = 0;
  for (let i = 0; i < index; i++) t += clipDuration(clips[i]);
  return t;
}

export function videoTotalDuration(clips) {
  return clips.reduce((sum, c) => sum + clipDuration(c), 0);
}

// Duración total de la timeline (el máximo entre todas las pistas).
export function projectDuration(project) {
  const vid = videoTotalDuration(project.tracks.video);
  let audioEnd = 0;
  for (const a of project.tracks.audio) {
    audioEnd = Math.max(audioEnd, a.start + (a.outPoint - a.inPoint));
  }
  let textEnd = 0;
  for (const t of project.tracks.text) textEnd = Math.max(textEnd, t.end);
  return Math.max(vid, audioEnd, textEnd, 0);
}

// Devuelve el clip de video activo en el tiempo t y el tiempo dentro del origen.
export function videoClipAt(clips, t) {
  let acc = 0;
  for (let i = 0; i < clips.length; i++) {
    const d = clipDuration(clips[i]);
    if (t >= acc && t < acc + d) {
      const local = t - acc;
      const srcTime = clips[i].type === 'video' ? clips[i].inPoint + local : 0;
      return { clip: clips[i], index: i, localTime: local, srcTime, start: acc };
    }
    acc += d;
  }
  return null;
}

export function formatTime(sec) {
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const d = Math.floor((sec * 10) % 10);
  return `${m}:${String(s).padStart(2, '0')}.${d}`;
}

// Cadena de filtro CSS para canvas a partir de los ajustes del clip.
export function clipFilterString(clip) {
  let f = `brightness(${clip.brightness}) contrast(${clip.contrast}) saturate(${clip.saturation})`;
  switch (clip.filter) {
    case 'bw': f += ' grayscale(1)'; break;
    case 'warm': f += ' sepia(.35) saturate(1.3) hue-rotate(-10deg)'; break;
    case 'cool': f += ' saturate(1.1) hue-rotate(20deg) brightness(1.03)'; break;
    case 'vivid': f += ' saturate(1.6) contrast(1.15)'; break;
    case 'vintage': f += ' sepia(.5) contrast(.9) brightness(1.05) saturate(.85)'; break;
  }
  return f;
}
