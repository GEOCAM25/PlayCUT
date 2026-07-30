// engine.js — Motor de reproducción y renderizado sobre <canvas>.
// Dibuja la timeline fotograma a fotograma y sincroniza los elementos de
// video/audio en tiempo real. El mismo render se usa para la exportación.

import {
  projectDuration, videoClipAt, clipFilterString, clipDuration,
} from './state.js';
import { blobURLFor, connectElement, setClipGain, getAudioContext } from './media.js';

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.project = null;
    this.elements = new Map(); // clipId -> { type, el|img, ready }
    this.playhead = 0;
    this.duration = 0;
    this.playing = false;
    this.onTick = null;       // (time, ended) => void
    this._raf = 0;
  }

  setProject(project) {
    this.project = project;
    this.canvas.width = project.width;
    this.canvas.height = project.height;
    this.recalc();
    this.syncElements();
    this.render(this.playhead);
  }

  recalc() {
    this.duration = projectDuration(this.project);
    if (this.playhead > this.duration) this.playhead = this.duration;
  }

  // Crea/elimina elementos según los clips actuales del proyecto.
  syncElements() {
    if (!this.project) return;
    const needed = new Set();
    for (const clip of this.project.tracks.video) {
      needed.add(clip.id);
      if (clip.type === 'video') this.ensureVideo(clip);
      else this.ensureImage(clip);
    }
    for (const clip of this.project.tracks.audio) {
      needed.add(clip.id);
      this.ensureAudio(clip);
    }
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
    el.addEventListener('canplay', () => { rec.ready = true; if (!this.playing) this.render(this.playhead); }, { once: false });
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

  // ---------------- Render ----------------
  render(t) {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.save();
    ctx.filter = 'none'; ctx.globalAlpha = 1;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    ctx.restore();

    const active = videoClipAt(this.project.tracks.video, t);
    if (active) this.drawClip(active.clip);

    for (const tc of this.project.tracks.text) {
      if (t >= tc.start && t < tc.end) this.drawText(tc);
    }
  }

  drawClip(clip) {
    const rec = this.elements.get(clip.id);
    if (!rec || !rec.ready) return;
    const ctx = this.ctx;
    const src = rec.type === 'image' ? rec.img : rec.el;
    const sw = rec.type === 'image' ? src.naturalWidth : src.videoWidth;
    const sh = rec.type === 'image' ? src.naturalHeight : src.videoHeight;
    if (!sw || !sh) return;
    ctx.save();
    ctx.globalAlpha = clip.opacity ?? 1;
    ctx.filter = clipFilterString(clip);
    this.drawContain(src, sw, sh);
    ctx.restore();
  }

  // Ajusta la fuente dentro del canvas conservando la proporción (letterbox).
  drawContain(src, sw, sh) {
    const W = this.canvas.width, H = this.canvas.height;
    const scale = Math.min(W / sw, H / sh);
    const w = sw * scale, h = sh * scale;
    this.ctx.drawImage(src, (W - w) / 2, (H - h) / 2, w, h);
  }

  drawText(tc) {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    const size = tc.size * (H / 1920);
    ctx.save();
    ctx.font = `700 ${size}px -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const x = tc.x * W, y = tc.y * H;
    const lines = String(tc.text).split('\n');
    const lineH = size * 1.2;
    let startY = y - (lines.length - 1) * lineH / 2;
    for (const line of lines) {
      if (tc.stroke) {
        ctx.lineWidth = size * 0.12;
        ctx.strokeStyle = 'rgba(0,0,0,.75)';
        ctx.lineJoin = 'round';
        ctx.strokeText(line, x, startY);
      }
      ctx.fillStyle = tc.color;
      ctx.fillText(line, x, startY);
      startY += lineH;
    }
    ctx.restore();
  }

  // ---------------- Reproducción ----------------
  play() {
    if (this.playing || this.duration <= 0) return;
    if (this.playhead >= this.duration - 0.02) this.playhead = 0;
    getAudioContext();
    this.applyGains();
    this.startPerf = performance.now();
    this.startPlayhead = this.playhead;
    this.playing = true;
    this.tick();
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this._raf);
    for (const rec of this.elements.values()) {
      if (rec.el && !rec.el.paused) rec.el.pause();
    }
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
    this.syncPlayback(t);
    this.render(t);
    this.onTick && this.onTick(t, false);
    this._raf = requestAnimationFrame(() => this.tick());
  }

  syncPlayback(t) {
    const active = videoClipAt(this.project.tracks.video, t);
    const activeId = active ? active.clip.id : null;
    for (const clip of this.project.tracks.video) {
      if (clip.type !== 'video') continue;
      const rec = this.elements.get(clip.id);
      if (!rec || !rec.el) continue;
      if (clip.id !== activeId && !rec.el.paused) rec.el.pause();
    }
    if (active && active.clip.type === 'video') {
      const rec = this.elements.get(active.clip.id);
      if (rec && rec.ready) {
        const expected = active.srcTime;
        if (Math.abs(rec.el.currentTime - expected) > 0.3) {
          try { rec.el.currentTime = expected; } catch {}
        }
        if (rec.el.paused) rec.el.play().catch(() => {});
      }
    }
    for (const clip of this.project.tracks.audio) {
      const rec = this.elements.get(clip.id);
      if (!rec || !rec.ready) continue;
      const dur = clip.outPoint - clip.inPoint;
      if (t >= clip.start && t < clip.start + dur) {
        const expected = clip.inPoint + (t - clip.start);
        if (Math.abs(rec.el.currentTime - expected) > 0.3) {
          try { rec.el.currentTime = expected; } catch {}
        }
        if (rec.el.paused) rec.el.play().catch(() => {});
      } else if (!rec.el.paused) {
        rec.el.pause();
      }
    }
  }

  // Posiciona la reproducción sin reproducir (scrubbing).
  seek(t) {
    this.playhead = Math.max(0, Math.min(t, this.duration));
    const active = videoClipAt(this.project.tracks.video, this.playhead);
    if (active && active.clip.type === 'video') {
      const rec = this.elements.get(active.clip.id);
      if (rec && rec.el) { try { rec.el.currentTime = active.srcTime; } catch {} }
    }
    this.render(this.playhead);
  }

  // Devuelve un dataURL del fotograma actual (para portada del proyecto).
  snapshot() {
    try { return this.canvas.toDataURL('image/jpeg', 0.6); } catch { return null; }
  }

  destroy() {
    this.pause();
    for (const rec of this.elements.values()) {
      if (rec.el) { try { rec.el.src = ''; } catch {} }
    }
    this.elements.clear();
  }
}
