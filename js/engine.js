// engine.js — Motor de reproducción y render sobre <canvas> (v2).
// Soporta transiciones reales (solapamiento), transformaciones por clip,
// movimiento Ken Burns, velocidad, fundidos de audio y render a 4K para exportar.

import {
  projectDuration, videoStateAt, clipDuration, clipFilterString, FONTS, overlayDuration,
} from './state.js';
import { blobURLFor, connectElement, setClipGain, getAudioContext } from './media.js';
import { getProfile } from './perf.js';

export class Engine {
  constructor(canvas) {
    this.previewCanvas = canvas;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.project = null;
    this.elements = new Map();
    this.playhead = 0;
    this.duration = 0;
    this.playing = false;
    this.onTick = null;
    this._raf = 0;
    this._captureTrack = null; // pista de captura durante la exportación
  }

  setProject(project) {
    this.project = project;
    this._sizePreview();
    this.recalc();
    this.syncElements();
    this.render(this.playhead);
  }

  // Dimensiona el lienzo de vista previa según el perfil de rendimiento.
  _sizePreview() {
    const s = getProfile().previewScale;
    const long = Math.max(this.project.width, this.project.height);
    // Limita el lado largo de la vista previa para ir fluida en gama baja.
    const cap = Math.round(long * s);
    const k = Math.min(1, cap / long);
    this.previewCanvas.width = Math.round(this.project.width * k) || 2;
    this.previewCanvas.height = Math.round(this.project.height * k) || 2;
  }

  applyRatio() {
    this._sizePreview();
    this.render(this.playhead);
  }

  applyPerf() {
    if (!this.playing) { this._sizePreview(); this.render(this.playhead); }
    else this._sizePreview();
  }

  recalc() {
    this.duration = projectDuration(this.project);
    if (this.playhead > this.duration) this.playhead = this.duration;
  }

  syncElements() {
    if (!this.project) return;
    const needed = new Set();
    for (const clip of this.project.tracks.video) {
      needed.add(clip.id);
      if (clip.type === 'video') this.ensureVideo(clip); else this.ensureImage(clip);
    }
    for (const clip of (this.project.tracks.overlay || [])) {
      needed.add(clip.id);
      if (clip.type === 'video') this.ensureVideo(clip); else this.ensureImage(clip);
    }
    for (const clip of this.project.tracks.audio) { needed.add(clip.id); this.ensureAudio(clip); }
    for (const id of [...this.elements.keys()]) {
      if (!needed.has(id)) {
        const rec = this.elements.get(id);
        if (rec && rec.el) { try { rec.el.pause(); rec.el.src = ''; } catch {} }
        this.elements.delete(id);
      }
    }
  }

  async ensureVideo(clip) {
    if (this.elements.has(clip.id)) return;
    const rec = { type: 'video', el: null, ready: false };
    this.elements.set(clip.id, rec);
    const el = document.createElement('video');
    el.playsInline = true; el.preload = 'auto'; el.crossOrigin = 'anonymous';
    el.setAttribute('playsinline', ''); el.setAttribute('webkit-playsinline', '');
    const url = await blobURLFor(clip.mediaId);
    if (!url) { this.elements.delete(clip.id); return; }
    el.src = url;
    el.addEventListener('canplay', () => { rec.ready = true; if (!this.playing) this.render(this.playhead); });
    el.addEventListener('loadeddata', () => { rec.ready = true; });
    el.addEventListener('seeked', () => { if (!this.playing) this.render(this.playhead); });
    rec.el = el;
    try { connectElement(clip.id, el); } catch {}
    setClipGain(clip.id, clip.volume ?? 1);
  }

  async ensureAudio(clip) {
    if (this.elements.has(clip.id)) return;
    const rec = { type: 'audio', el: null, ready: false };
    this.elements.set(clip.id, rec);
    const el = document.createElement('audio');
    el.preload = 'auto';
    const url = await blobURLFor(clip.mediaId);
    if (!url) { this.elements.delete(clip.id); return; }
    el.src = url;
    el.addEventListener('canplay', () => { rec.ready = true; });
    el.addEventListener('loadeddata', () => { rec.ready = true; });
    rec.el = el;
    try { connectElement(clip.id, el); } catch {}
    setClipGain(clip.id, clip.volume ?? 1);
  }

  async ensureImage(clip) {
    if (this.elements.has(clip.id)) return;
    const rec = { type: 'image', img: null, ready: false };
    this.elements.set(clip.id, rec);
    const url = await blobURLFor(clip.mediaId);
    if (!url) { this.elements.delete(clip.id); return; }
    const img = new Image();
    img.onload = () => { rec.ready = true; if (!this.playing) this.render(this.playhead); };
    img.src = url;
    rec.img = img;
  }

  applyGains() {
    for (const clip of this.project.tracks.video) setClipGain(clip.id, clip.volume ?? 1);
    for (const clip of this.project.tracks.audio) setClipGain(clip.id, clip.volume ?? 1);
  }

  // ==================== RENDER ====================
  render(t) {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.save(); ctx.filter = 'none'; ctx.globalAlpha = 1;
    ctx.fillStyle = this.project.bgColor || '#000'; ctx.fillRect(0, 0, W, H); ctx.restore();

    const vs = videoStateAt(this.project.tracks.video, t);
    if (vs) {
      if (vs.b) this.drawTransition(vs);
      else this.drawClip(vs.a, vs.localA, {});
    }

    // Capa superpuesta (PiP), encima del video principal.
    for (const ov of (this.project.tracks.overlay || [])) {
      const d = overlayDuration(ov);
      if (t >= ov.start && t < ov.start + d) this.drawClip(ov, t - ov.start, { isOverlay: true });
    }

    for (const tc of this.project.tracks.text) {
      if (t >= tc.start && t < tc.end) this.drawText(tc, t);
    }

    // Durante la exportación, fuerza la captura de este fotograma.
    if (this._captureTrack && this._captureTrack.requestFrame) {
      try { this._captureTrack.requestFrame(); } catch {}
    }
  }

  // Progreso 0..1 dentro del propio clip (para movimiento).
  _clipProgress(clip, local) {
    const d = clipDuration(clip);
    return d > 0 ? Math.min(1, Math.max(0, local / d)) : 0;
  }

  // Calcula parámetros de movimiento Ken Burns.
  _motion(clip, q) {
    let scale = 1, dx = 0, dy = 0, cover = false;
    switch (clip.motion) {
      case 'zoomIn': scale = 1 + 0.15 * q; cover = true; break;
      case 'zoomOut': scale = 1.15 - 0.15 * q; cover = true; break;
      case 'panL': scale = 1.12; dx = (0.5 - q) * 0.12; cover = true; break;
      case 'panR': scale = 1.12; dx = (q - 0.5) * 0.12; cover = true; break;
      case 'panU': scale = 1.12; dy = (0.5 - q) * 0.12; cover = true; break;
      case 'panD': scale = 1.12; dy = (q - 0.5) * 0.12; cover = true; break;
    }
    return { scale, dx, dy, cover };
  }

  drawClip(clip, local, extra) {
    const rec = this.elements.get(clip.id);
    if (!rec || !rec.ready) return;
    const src = rec.type === 'image' ? rec.img : rec.el;
    const sw = rec.type === 'image' ? src.naturalWidth : src.videoWidth;
    const sh = rec.type === 'image' ? src.naturalHeight : src.videoHeight;
    if (!sw || !sh) return;

    const q = this._clipProgress(clip, local);
    const m = this._motion(clip, q);
    const W = this.canvas.width, H = this.canvas.height;
    const useCover = clip.fillMode === 'cover' || m.cover;

    // Fondo difuminado si hay barras (modo contain) — solo para el clip base.
    if (!extra.isOverlay && !useCover && clip.bg === 'blur') {
      this.ctx.save();
      this.ctx.filter = 'blur(28px) brightness(.6)';
      this._drawFit(src, sw, sh, true, 1.15, 0, 0, 0);
      this.ctx.restore();
    }

    this.ctx.save();
    this.ctx.globalAlpha = (clip.opacity ?? 1) * (extra.alpha ?? 1);
    let filter = clipFilterString(clip);
    if (extra.filter) filter += ' ' + extra.filter;
    this.ctx.filter = filter;

    if (extra.clipRect) {
      const r = extra.clipRect;
      this.ctx.beginPath();
      this.ctx.rect(r.x * W, r.y * H, r.w * W, r.h * H);
      this.ctx.clip();
    }

    const totalScale = (clip.scale || 1) * m.scale * (extra.scale ?? 1);
    const tx = (clip.offsetX || 0) * W + m.dx * W + (extra.tx || 0);
    const ty = (clip.offsetY || 0) * H + m.dy * H + (extra.ty || 0);
    const rot = ((clip.rotate || 0) + (extra.rotate || 0)) * Math.PI / 180;

    this._drawFit(src, sw, sh, useCover, totalScale, tx, ty, rot,
      extra.isOverlay ? { radius: clip.radius, shadow: clip.shadow } : null);
    this.ctx.restore();
  }

  _drawFit(src, sw, sh, cover, scale, tx, ty, rot, opts) {
    const W = this.canvas.width, H = this.canvas.height;
    const base = cover ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
    const w = sw * base * scale, h = sh * base * scale;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(W / 2 + tx, H / 2 + ty);
    if (rot) ctx.rotate(rot);
    const r = opts && opts.radius ? opts.radius * Math.min(w, h) : 0;
    if (opts && opts.shadow) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.55)';
      ctx.shadowBlur = Math.max(w, h) * 0.05;
      ctx.shadowOffsetY = h * 0.012;
      ctx.fillStyle = '#000';
      this._roundRect(ctx, -w / 2, -h / 2, w, h, r);
      ctx.fill();
      ctx.restore();
    }
    if (r > 0) { this._roundRect(ctx, -w / 2, -h / 2, w, h, r); ctx.clip(); }
    ctx.drawImage(src, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  drawTransition(vs) {
    const { a, b, p, localA, localB, type } = vs;
    const W = this.canvas.width, H = this.canvas.height;
    const ctx = this.ctx;
    switch (type) {
      case 'fadeblack':
        this.drawClip(a, localA, { alpha: Math.max(0, 1 - 2 * p) });
        this.drawClip(b, localB, { alpha: Math.max(0, 2 * p - 1) });
        break;
      case 'fadewhite':
        this.drawClip(a, localA, { alpha: 1 });
        this.drawClip(b, localB, { alpha: p });
        ctx.save(); ctx.globalAlpha = Math.sin(p * Math.PI) * 0.95; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.restore();
        break;
      case 'slideleft':
        this.drawClip(a, localA, { tx: -p * W });
        this.drawClip(b, localB, { tx: (1 - p) * W });
        break;
      case 'slideright':
        this.drawClip(a, localA, { tx: p * W });
        this.drawClip(b, localB, { tx: -(1 - p) * W });
        break;
      case 'slideup':
        this.drawClip(a, localA, { ty: -p * H });
        this.drawClip(b, localB, { ty: (1 - p) * H });
        break;
      case 'slidedown':
        this.drawClip(a, localA, { ty: p * H });
        this.drawClip(b, localB, { ty: -(1 - p) * H });
        break;
      case 'zoomin':
        this.drawClip(a, localA, {});
        this.drawClip(b, localB, { alpha: p, scale: 1.4 - 0.4 * p });
        break;
      case 'wipeleft':
        this.drawClip(a, localA, {});
        this.drawClip(b, localB, { clipRect: { x: 0, y: 0, w: p, h: 1 } });
        break;
      case 'wiperight':
        this.drawClip(a, localA, {});
        this.drawClip(b, localB, { clipRect: { x: 1 - p, y: 0, w: p, h: 1 } });
        break;
      case 'blur':
        this.drawClip(a, localA, { filter: `blur(${p * 18}px)`, alpha: 1 });
        this.drawClip(b, localB, { filter: `blur(${(1 - p) * 18}px)`, alpha: p });
        break;
      case 'spin':
        this.drawClip(a, localA, { rotate: p * 90, alpha: 1 - p, scale: 1 - 0.3 * p });
        this.drawClip(b, localB, { rotate: (p - 1) * 90, alpha: p, scale: 0.7 + 0.3 * p });
        break;
      case 'dissolve':
      default:
        this.drawClip(a, localA, {});
        this.drawClip(b, localB, { alpha: p });
        break;
    }
  }

  drawText(tc, t) {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    const dur = tc.end - tc.start;
    const local = t - tc.start;
    // Animaciones de entrada/salida.
    let alpha = 1, sx = 1, ty = 0;
    const IN = Math.min(0.4, dur / 2), OUT = Math.min(0.4, dur / 2);
    if (tc.animIn !== 'none' && local < IN) {
      const k = local / IN;
      if (tc.animIn === 'fade') alpha = k;
      else if (tc.animIn === 'pop') { alpha = k; sx = 0.6 + 0.4 * k; }
      else if (tc.animIn === 'slideup') { alpha = k; ty = (1 - k) * H * 0.08; }
      else if (tc.animIn === 'slidedown') { alpha = k; ty = -(1 - k) * H * 0.08; }
    }
    if (tc.animOut !== 'none' && local > dur - OUT) {
      const k = (dur - local) / OUT;
      if (tc.animOut === 'fade') alpha = Math.min(alpha, k);
      else if (tc.animOut === 'pop') { alpha = Math.min(alpha, k); sx = 0.6 + 0.4 * k; }
      else if (tc.animOut === 'slideup') { alpha = Math.min(alpha, k); ty = -(1 - k) * H * 0.08; }
      else if (tc.animOut === 'slidedown') { alpha = Math.min(alpha, k); ty = (1 - k) * H * 0.08; }
    }

    const size = tc.size * (H / 1920);
    const font = FONTS[tc.font] || FONTS.sans;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(tc.x * W, tc.y * H + ty);
    if (tc.rotate) ctx.rotate(tc.rotate * Math.PI / 180);
    ctx.scale(sx, sx);
    ctx.font = `${tc.bold ? '800' : '500'} ${size}px ${font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = String(tc.text).split('\n');
    const lineH = size * 1.22;
    let startY = -(lines.length - 1) * lineH / 2;

    // Fondo del texto.
    if (tc.bg !== 'none') {
      let maxW = 0;
      for (const l of lines) maxW = Math.max(maxW, ctx.measureText(l).width);
      const padX = size * 0.4, padY = size * 0.22;
      const bw = maxW + padX * 2, bh = lines.length * lineH + padY * 2 - (lineH - size);
      ctx.fillStyle = tc.bg === 'black' ? 'rgba(0,0,0,.65)' : tc.bg === 'white' ? 'rgba(255,255,255,.85)' : tc.bgColor;
      this._roundRect(ctx, -bw / 2, startY - lineH / 2 - padY + lineH / 2, bw, bh, size * 0.18);
      ctx.fill();
    }

    for (const line of lines) {
      if (tc.stroke && tc.bg === 'none') {
        ctx.lineWidth = size * 0.14; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.lineJoin = 'round';
        ctx.strokeText(line, 0, startY);
      }
      ctx.fillStyle = (tc.bg === 'white') ? '#111' : tc.color;
      ctx.fillText(line, 0, startY);
      startY += lineH;
    }
    ctx.restore();
  }

  _roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ==================== REPRODUCCIÓN ====================
  play() {
    if (this.playing || this.duration <= 0) return;
    if (this.playhead >= this.duration - 0.02) this.playhead = 0;
    getAudioContext();
    this.startPerf = performance.now();
    this.startPlayhead = this.playhead;
    this.playing = true;
    this.tick();
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this._raf);
    for (const rec of this.elements.values()) if (rec.el && !rec.el.paused) rec.el.pause();
  }

  tick() {
    if (!this.playing) return;
    const now = performance.now();
    let t = this.startPlayhead + (now - this.startPerf) / 1000;
    if (t >= this.duration) {
      this.playhead = this.duration;
      this.render(this.duration);
      this.pause();
      this.onTick && this.onTick(this.duration, true);
      return;
    }
    this.playhead = t;
    // Límite de fps de vista previa según el perfil (ahorra batería en gama
    // baja). Durante la exportación se renderiza siempre a máxima cadencia.
    const minI = this._exporting ? 0 : (1000 / (getProfile().targetFps || 60)) - 1;
    if (now - (this._lastRenderPerf || 0) >= minI) {
      this._lastRenderPerf = now;
      this.syncPlayback(t);
      this.render(t);
    }
    this.onTick && this.onTick(t, false);
    this._raf = requestAnimationFrame(() => this.tick());
  }

  _audioEnv(clip, t, start, end) {
    let e = 1;
    if (clip.fadeIn > 0) e = Math.min(e, Math.max(0, (t - start) / clip.fadeIn));
    if (clip.fadeOut > 0) e = Math.min(e, Math.max(0, (end - t) / clip.fadeOut));
    return e;
  }

  syncPlayback(t) {
    const vs = videoStateAt(this.project.tracks.video, t);
    const activeIds = new Set();
    if (vs) { if (vs.a) activeIds.add(vs.a.id); if (vs.b) activeIds.add(vs.b.id); }

    for (const clip of this.project.tracks.video) {
      if (clip.type !== 'video') continue;
      const rec = this.elements.get(clip.id);
      if (!rec || !rec.el) continue;
      if (!activeIds.has(clip.id) && !rec.el.paused) rec.el.pause();
    }

    const drive = (clip, local, isB) => {
      if (!clip || clip.type !== 'video') return;
      const rec = this.elements.get(clip.id);
      if (!rec || !rec.ready) return;
      const expected = clip.inPoint + local * (clip.speed || 1);
      if (Math.abs(rec.el.currentTime - expected) > 0.34) { try { rec.el.currentTime = expected; } catch {} }
      rec.el.playbackRate = clip.speed || 1;
      if (rec.el.paused) rec.el.play().catch(() => {});
      // Crossfade de audio durante transición.
      let g = clip.volume ?? 1;
      if (vs && vs.b) g *= isB ? vs.p : (1 - vs.p);
      setClipGain(clip.id, g);
    };
    if (vs) { drive(vs.a, vs.localA, false); if (vs.b) drive(vs.b, vs.localB, true); }

    // Pista de audio con fundidos.
    for (const clip of this.project.tracks.audio) {
      const rec = this.elements.get(clip.id);
      if (!rec || !rec.ready) continue;
      const dur = clip.outPoint - clip.inPoint;
      const start = clip.start, end = clip.start + dur;
      if (t >= start && t < end) {
        const expected = clip.inPoint + (t - start);
        if (Math.abs(rec.el.currentTime - expected) > 0.34) { try { rec.el.currentTime = expected; } catch {} }
        if (rec.el.paused) rec.el.play().catch(() => {});
        setClipGain(clip.id, (clip.volume ?? 1) * this._audioEnv(clip, t, start, end));
      } else if (!rec.el.paused) rec.el.pause();
    }

    // Capa overlay (PiP): reproduce videos superpuestos activos.
    for (const clip of (this.project.tracks.overlay || [])) {
      if (clip.type !== 'video') continue;
      const rec = this.elements.get(clip.id);
      if (!rec || !rec.ready) continue;
      const dur = overlayDuration(clip);
      const start = clip.start, end = clip.start + dur;
      if (t >= start && t < end) {
        const expected = clip.inPoint + (t - start) * (clip.speed || 1);
        if (Math.abs(rec.el.currentTime - expected) > 0.34) { try { rec.el.currentTime = expected; } catch {} }
        rec.el.playbackRate = clip.speed || 1;
        if (rec.el.paused) rec.el.play().catch(() => {});
        setClipGain(clip.id, (clip.volume ?? 1) * this._audioEnv(clip, t, start, end));
      } else if (!rec.el.paused) rec.el.pause();
    }
  }

  seek(t) {
    this.playhead = Math.max(0, Math.min(t, this.duration));
    const vs = videoStateAt(this.project.tracks.video, this.playhead);
    const setT = (clip, local) => {
      if (!clip || clip.type !== 'video') return;
      const rec = this.elements.get(clip.id);
      if (rec && rec.el) { try { rec.el.currentTime = clip.inPoint + local * (clip.speed || 1); } catch {} }
    };
    if (vs) { setT(vs.a, vs.localA); if (vs.b) setT(vs.b, vs.localB); }
    for (const ov of (this.project.tracks.overlay || [])) {
      if (ov.type !== 'video') continue;
      const d = overlayDuration(ov);
      if (this.playhead >= ov.start && this.playhead < ov.start + d) {
        const rec = this.elements.get(ov.id);
        if (rec && rec.el) { try { rec.el.currentTime = ov.inPoint + (this.playhead - ov.start) * (ov.speed || 1); } catch {} }
      }
    }
    this.render(this.playhead);
  }

  snapshot() { try { return this.previewCanvas.toDataURL('image/jpeg', 0.6); } catch { return null; } }

  // ==================== EXPORTAR EN ALTA RESOLUCIÓN ====================
  beginExport(w, h) {
    this._prevCanvas = this.canvas; this._prevCtx = this.ctx;
    this._exporting = true;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    this.canvas = c; this.ctx = c.getContext('2d', { alpha: false });
    return c;
  }
  endExport() {
    this._exporting = false;
    if (this._prevCanvas) { this.canvas = this._prevCanvas; this.ctx = this._prevCtx; this._prevCanvas = null; }
    this.render(this.playhead);
  }

  destroy() {
    this.pause();
    for (const rec of this.elements.values()) if (rec.el) { try { rec.el.src = ''; } catch {} }
    this.elements.clear();
  }
}
