// engine.js — Motor de reproducción y render sobre <canvas> (v2).
// Soporta transiciones reales (solapamiento), transformaciones por clip,
// movimiento Ken Burns, velocidad, fundidos de audio y render a 4K para exportar.

import {
  projectDuration, videoStateAt, clipDuration, clipFilterString, FONTS, overlayDuration,
  overlaysInOrder,
} from './state.js';
import { blobURLFor, connectElement, setClipGain, disconnectClip, getAudioContext, loadMediaRecord } from './media.js';
import { getProfile } from './perf.js';
import { crvActive, crvKey, crvTables } from './curves.js';

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
    this._chromaScratch = document.createElement('canvas'); // para video
    this._chromaCache = new Map(); // imágenes procesadas (clipId -> {key, canvas})
    this._curveScratch = document.createElement('canvas'); // curvas sobre video
    this._curveCache = new Map();  // imágenes ya graduadas (clipId -> {key, canvas})
    this._curveLUTs = new Map();   // tablas 256 por clip (clipId -> {key, t})
    this._lensScratch = document.createElement('canvas'); // lente sobre video
    this._lensCache = new Map();   // fotos ya corregidas (clipId -> {key, canvas})
    this._lensMaps = new Map();    // tabla de remapeo (clave -> Int32Array)
    this._focusScratch = document.createElement('canvas'); // desenfoque selectivo
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
        if (rec && rec.el) { try { rec.el.pause(); rec.el.removeAttribute('src'); rec.el.load(); } catch {} }
        if (rec && rec.img && rec.img.parentNode) rec.img.remove();
        // Libera el nodo de audio: si el clip vuelve (deshacer), se reconecta
        // al elemento nuevo en vez de quedarse mudo con el nodo antiguo.
        disconnectClip(id);
        this._chromaCache.delete(id);
        this._curveCache.delete(id);
        this._curveLUTs.delete(id);
        this._lensCache.delete(id);
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
    el.addEventListener('error', () => { this.onMediaError && this.onMediaError(clip); });
    // Corrige la duración si el clip se importó sin ella (p. ej. video de iPhone).
    el.addEventListener('loadedmetadata', () => {
      const d = el.duration;
      if (d && isFinite(d) && (clip._autoDur || !clip.srcDuration || clip.srcDuration < 0.1)) {
        const wasFull = clip.inPoint <= 0.001 && (clip.outPoint <= 0.1 || Math.abs(clip.outPoint - clip.srcDuration) < 0.01 || clip._autoDur);
        clip.srcDuration = d;
        if (wasFull) { clip.inPoint = 0; clip.outPoint = d; }
        delete clip._autoDur;
        this.recalc();
        if (!this.playing) this.render(this.playhead);
        this.onClipUpdated && this.onClipUpdated();
      }
    });
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
    const rec = { type: 'image', img: null, ready: false, gif: false };
    this.elements.set(clip.id, rec);
    const url = await blobURLFor(clip.mediaId);
    if (!url) { this.elements.delete(clip.id); return; }
    const img = new Image();
    img.onload = () => { rec.ready = true; if (!this.playing) this.render(this.playhead); };
    img.src = url;
    rec.img = img;
    // Los GIF animados deben estar en el árbol de render para reproducirse.
    const media = await loadMediaRecord(clip.mediaId);
    if (media && media.mime === 'image/gif') {
      rec.gif = true;
      img.style.cssText = 'position:fixed;left:-99999px;top:0;width:64px;height:64px;opacity:0;pointer-events:none;';
      document.body.appendChild(img);
    }
  }

  _vol(clip) { return clip.muted ? 0 : (clip.volume ?? 1); }

  applyGains() {
    for (const clip of this.project.tracks.video) setClipGain(clip.id, this._vol(clip));
    for (const clip of (this.project.tracks.overlay || [])) setClipGain(clip.id, this._vol(clip));
    for (const clip of this.project.tracks.audio) setClipGain(clip.id, this._vol(clip));
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
      // Desenfoque selectivo del clip base, antes de viñeta/grano y de todo lo
      // que va encima (la superposición y el texto se quedan nítidos).
      const foco = vs.a.focus;
      if (foco && foco.mode && foco.mode !== 'none' && (foco.amount || 0) > 0) this._applyFocus(foco);
      // Viñeta del clip base (oscurece las esquinas), bajo la superposición y el texto.
      const vAmt = vs.b ? Math.max(vs.a.vignette || 0, vs.b.vignette || 0) : (vs.a.vignette || 0);
      if (vAmt) this._drawVignette(vAmt / 100);
      const gAmt = vs.b ? Math.max(vs.a.grain || 0, vs.b.grain || 0) : (vs.a.grain || 0);
      if (gAmt) this._drawGrain(gAmt / 100);
    }

    // Capa superpuesta (PiP), encima del video principal, con modo de mezcla.
    const BLEND = { normal: 'source-over', screen: 'screen', multiply: 'multiply', add: 'lighter', overlay: 'overlay', difference: 'difference', hardlight: 'hard-light', softlight: 'soft-light', lighten: 'lighten', darken: 'darken', colordodge: 'color-dodge', exclusion: 'exclusion' };
    // De abajo arriba: la capa 0 se dibuja primero y las de encima la tapan.
    for (const ov of overlaysInOrder(this.project)) {
      const d = overlayDuration(ov);
      if (t >= ov.start && t < ov.start + d) {
        const prevOp = ctx.globalCompositeOperation;
        ctx.globalCompositeOperation = BLEND[ov.blend] || 'source-over';
        this.drawClip(ov, t - ov.start, { isOverlay: true });
        ctx.globalCompositeOperation = prevOp;
      }
    }

    for (const tc of this.project.tracks.text) {
      if (t >= tc.start && t < tc.end) this.drawText(tc, t);
    }

    // Fundido de entrada/salida del proyecto (a negro), sobre todo lo demás.
    const fi = this.project.fadeIn || 0, fo = this.project.fadeOut || 0;
    if (fi || fo) {
      const total = projectDuration(this.project);
      let a = 0;
      if (fi > 0 && t < fi) a = Math.max(a, 1 - t / fi);
      if (fo > 0 && t > total - fo) a = Math.max(a, 1 - (total - t) / fo);
      if (a > 0.001) {
        ctx.save();
        ctx.filter = 'none'; ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = Math.min(1, a); ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
    }

    // Guías de encuadre seguro: marcan la zona que tapan los botones de
    // TikTok/Reels/Shorts. Solo ayuda visual — nunca se exporta.
    if (this.showSafeZones && !this._exporting) this._drawSafeZones();

    // Histograma en vivo. Se pinta en un lienzo APARTE (nunca sobre la vista
    // previa) para que no se exporte ni se lea a sí mismo en el fotograma
    // siguiente. Se refresca a ~8 fps: leer píxeles es caro.
    if (this.histogramCanvas && !this._exporting) {
      const nowH = performance.now();
      if (nowH - (this._histAt || 0) > 125) { this._histAt = nowH; this._drawHistogram(); }
    }

    // Durante la exportación, fuerza la captura de este fotograma.
    if (this._captureTrack && this._captureTrack.requestFrame) {
      try { this._captureTrack.requestFrame(); } catch {}
    }
  }

  // Dibuja una viñeta radial sobre todo el fotograma.
  _drawVignette(amt) {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.save();
    ctx.filter = 'none'; ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.33, W / 2, H / 2, Math.max(W, H) * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.6, `rgba(0,0,0,${(amt * 0.25).toFixed(3)})`);
    g.addColorStop(1, `rgba(0,0,0,${(amt * 0.85).toFixed(3)})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // Captura el fotograma actual del clip base a máxima resolución del proyecto
  // (para «congelar»). Devuelve un Blob PNG, o null si no hay clip bajo el cursor.
  async captureBaseFrame() {
    const vs = videoStateAt(this.project.tracks.video, this.playhead);
    if (!vs) return null;
    const off = document.createElement('canvas');
    off.width = this.project.width; off.height = this.project.height;
    const offctx = off.getContext('2d');
    const savedCanvas = this.canvas, savedCtx = this.ctx;
    this.canvas = off; this.ctx = offctx;
    try {
      offctx.fillStyle = this.project.bgColor || '#000';
      offctx.fillRect(0, 0, off.width, off.height);
      if (vs.b) this.drawTransition(vs); else this.drawClip(vs.a, vs.localA, {});
    } finally { this.canvas = savedCanvas; this.ctx = savedCtx; }
    return await new Promise((res) => off.toBlob(res, 'image/png'));
  }

  // Histograma RGB del fotograma actual: muestra cómo se reparten las luces
  // y las sombras. Útil para ver si el video está quemado o muy oscuro.
  _drawHistogram() {
    const out = this.histogramCanvas;
    const src = this.previewCanvas;
    if (!out || !src.width || !src.height) return;
    let data;
    try {
      // Muestreo reducido: basta una rejilla para la forma de la curva.
      const s = this._histScratch || (this._histScratch = document.createElement('canvas'));
      const W = 160, H = Math.max(1, Math.round(160 * src.height / src.width));
      s.width = W; s.height = H;
      const sc = s.getContext('2d', { willReadFrequently: true });
      sc.drawImage(src, 0, 0, W, H);
      data = sc.getImageData(0, 0, W, H).data;
    } catch { return; }

    const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 4) { r[data[i]]++; g[data[i + 1]]++; b[data[i + 2]]++; }
    let max = 1;
    for (let i = 1; i < 255; i++) { // ignora los extremos, suelen dominar
      if (r[i] > max) max = r[i];
      if (g[i] > max) max = g[i];
      if (b[i] > max) max = b[i];
    }

    const ctx = out.getContext('2d');
    const W = out.width, H = out.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(6,6,10,.72)';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    const draw = (arr, color) => {
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let i = 0; i < 256; i++) {
        const x = (i / 255) * W;
        const y = H - Math.min(1, arr[i] / max) * (H - 3);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    };
    draw(r, 'rgba(255,64,80,.55)');
    draw(g, 'rgba(60,235,140,.55)');
    draw(b, 'rgba(70,150,255,.55)');
    ctx.globalCompositeOperation = 'source-over';
  }

  // Zonas seguras para redes verticales: arriba el nombre/estado, abajo la
  // descripción y a la derecha la botonera. Lo de dentro del rectángulo
  // punteado se ve siempre sin que lo tape la interfaz de la red social.
  _drawSafeZones() {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    const top = H * 0.08, bottom = H * 0.20, right = W * 0.16, left = W * 0.04;
    ctx.save();
    ctx.filter = 'none'; ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    // Sombreado de las zonas que quedan tapadas.
    ctx.fillStyle = 'rgba(255,60,90,.16)';
    ctx.fillRect(0, 0, W, top);
    ctx.fillRect(0, H - bottom, W, bottom);
    ctx.fillRect(W - right, top, right, H - top - bottom);
    ctx.fillRect(0, top, left, H - top - bottom);
    // Marco de la zona segura.
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = Math.max(2, W * 0.004);
    ctx.setLineDash([W * 0.02, W * 0.02]);
    ctx.strokeRect(left, top, W - left - right, H - top - bottom);
    ctx.restore();
  }

  // Grano de película: superpone ruido (tejado en mosaico) desplazado cada
  // fotograma. El patrón se genera una sola vez y se cachea.
  _drawGrain(amt) {
    if (!this._grainTile) {
      const t = document.createElement('canvas'); t.width = t.height = 128;
      const tctx = t.getContext('2d');
      const img = tctx.createImageData(128, 128);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = (Math.random() * 255) | 0;
        d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
      }
      tctx.putImageData(img, 0, 0);
      this._grainTile = t;
    }
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.save();
    ctx.filter = 'none';
    ctx.globalAlpha = Math.min(0.5, amt * 0.5);
    ctx.globalCompositeOperation = 'overlay';
    const pat = ctx.createPattern(this._grainTile, 'repeat');
    const ox = (Math.random() * 128) | 0, oy = (Math.random() * 128) | 0;
    ctx.translate(-ox, -oy);
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, W + 128, H + 128);
    ctx.restore();
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
      case 'panUL': scale = 1.16; dx = (0.5 - q) * 0.1; dy = (0.5 - q) * 0.1; cover = true; break;
      case 'panDR': scale = 1.16; dx = (q - 0.5) * 0.1; dy = (q - 0.5) * 0.1; cover = true; break;
      case 'zoomInFast': scale = 1 + 0.3 * q; cover = true; break;
      case 'zoomPanR': scale = 1.18 - 0.06 * q; dx = (q - 0.5) * 0.14; cover = true; break;
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

    // Chroma key (pantalla verde): sustituye la fuente por una versión con el
    // color recortado a transparente.
    let dsrc = src, dsw = sw, dsh = sh;
    if (clip.chroma && clip.chroma.on) {
      const keyed = this._chromaProcess(clip, src, sw, sh, rec.type === 'image');
      if (keyed) { dsrc = keyed; dsw = keyed.width; dsh = keyed.height; }
    }

    // Curvas de color (PRO): reasigna cada tono con una tabla de 256 valores.
    if (crvActive(clip.curves)) {
      const graded = this._curveProcess(clip, dsrc, dsw, dsh, rec.type === 'image');
      if (graded) { dsrc = graded; dsw = graded.width; dsh = graded.height; }
    }

    // Corrección de lente: endereza el abombado del gran angular (o lo añade).
    if (clip.lens) {
      const recto = this._lensProcess(clip, dsrc, dsw, dsh, rec.type === 'image');
      if (recto) { dsrc = recto; dsw = recto.width; dsh = recto.height; }
    }

    // Recorte manual: nos quedamos solo con una parte de la imagen original.
    // Se guarda en fracciones (0..1) para que valga a cualquier resolución.
    let srcRect = null;
    const cr = clip.crop;
    if (cr && (cr.x > 0.001 || cr.y > 0.001 || cr.w < 0.999 || cr.h < 0.999)) {
      const sx = Math.max(0, Math.min(1, cr.x)) * dsw;
      const sy = Math.max(0, Math.min(1, cr.y)) * dsh;
      const sW = Math.max(2, Math.min(dsw - sx, cr.w * dsw));
      const sH = Math.max(2, Math.min(dsh - sy, cr.h * dsh));
      srcRect = { sx, sy, sw: sW, sh: sH };
      // El encaje se calcula con el tamaño ya recortado.
      dsw = sW; dsh = sH;
    }

    const q = this._clipProgress(clip, local);
    const m = this._motion(clip, q);
    const W = this.canvas.width, H = this.canvas.height;
    const useCover = clip.fillMode === 'cover' || m.cover;

    // Relleno de las barras (modo contain) — solo para el clip base.
    if (!extra.isOverlay && !useCover && !(clip.chroma && clip.chroma.on)) {
      if (clip.bg === 'blur') {
        this.ctx.save();
        this.ctx.filter = 'blur(28px) brightness(.6)';
        this._drawFit(src, sw, sh, true, 1.15, 0, 0, 0);
        this.ctx.restore();
      } else if (clip.bg && clip.bg !== 'none') {
        const col = clip.bg === 'black' ? '#000' : clip.bg === 'white' ? '#fff'
          : (clip.bg[0] === '#' ? clip.bg : (this.project.bgColor || '#000'));
        this.ctx.save(); this.ctx.fillStyle = col; this.ctx.fillRect(0, 0, W, H); this.ctx.restore();
      }
    }

    // Transformación: keyframes (si hay) o valores base del clip.
    const kf = this._kfTransform(clip, local);
    const tScale = kf ? kf.scale : (clip.scale || 1);
    const tOx = kf ? kf.offsetX : (clip.offsetX || 0);
    const tOy = kf ? kf.offsetY : (clip.offsetY || 0);
    const tRot = kf ? kf.rotate : (clip.rotate || 0);
    const tOpacity = kf ? kf.opacity : (clip.opacity ?? 1);

    // Animación de entrada/salida del clip (fade, zoom, deslizar, pop, giro).
    const cdur = extra.isOverlay ? overlayDuration(clip) : clipDuration(clip);
    const anim = this._clipAnim(clip, local, cdur);

    this.ctx.save();
    this.ctx.globalAlpha = tOpacity * (extra.alpha ?? 1) * anim.alpha;
    let filter = clipFilterString(clip);
    if (extra.filter) filter += ' ' + extra.filter;
    this.ctx.filter = filter;

    if (extra.clipRect) {
      const r = extra.clipRect;
      this.ctx.beginPath();
      this.ctx.rect(r.x * W, r.y * H, r.w * W, r.h * H);
      this.ctx.clip();
    }

    // Estabilización: compensa el temblor medido y amplía lo justo para que
    // el movimiento no descubra los bordes.
    const st = this._stabAt(clip, local);
    const totalScale = tScale * m.scale * (extra.scale ?? 1) * anim.scale * (st ? st.zoom : 1);
    const tx = tOx * W + m.dx * W + (extra.tx || 0) + anim.dx * W + (st ? st.dx * W : 0);
    const ty = tOy * H + m.dy * H + (extra.ty || 0) + anim.dy * H + (st ? st.dy * H : 0);
    const rot = (tRot + (extra.rotate || 0) + anim.rot) * Math.PI / 180;

    const chromaOn = !!(clip.chroma && clip.chroma.on);
    const blended = extra.isOverlay && clip.blend && clip.blend !== 'normal';
    const masked = clip.mask && clip.mask !== 'none';
    const fitOpts = { mask: masked ? clip.mask : null, flipH: !!clip.flipH, flipV: !!clip.flipV, srcRect };
    if (extra.isOverlay) {
      fitOpts.radius = (chromaOn || masked) ? 0 : clip.radius;
      fitOpts.shadow = clip.shadow && !chromaOn && !blended && !masked;
      if (clip.borderW > 0) fitOpts.border = { w: clip.borderW, color: clip.borderColor || '#fff' };
    }
    this._drawFit(dsrc, dsw, dsh, useCover, totalScale, tx, ty, rot, fitOpts);
    this.ctx.restore();
  }

  // Desplazamiento de estabilización en el tiempo local del clip.
  _stabAt(clip, local) {
    const s = clip.stab;
    if (!s || !s.on || !s.pts || !s.pts.length) return null;
    const fuerza = s.strength ?? 1;
    const zoom = 1 + ((s.zoom || 1) - 1) * fuerza;
    const src = clip.inPoint + local * (clip.speed || 1);
    // Busca el fotograma que se está viendo (el último que empezó antes de
    // `src`). Es una búsqueda binaria: la lista puede tener cientos de puntos.
    const pts = s.pts;
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pts[mid][0] <= src) lo = mid; else hi = mid - 1;
    }
    const p = pts[lo];
    return { dx: p[1] * fuerza, dy: p[2] * fuerza, zoom };
  }

  // Combina la animación de entrada y salida del clip en el tiempo local.
  _clipAnim(clip, local, dur) {
    let a = { alpha: 1, scale: 1, dx: 0, dy: 0, rot: 0 };
    if (!dur || dur <= 0) return a;
    const din = Math.min(clip.animInDur || 0.5, dur / 2);
    const dout = Math.min(clip.animOutDur || 0.5, dur / 2);
    if (clip.animIn && clip.animIn !== 'none' && local < din) {
      const p = Math.max(0, Math.min(1, local / din));
      this._mergeAnim(a, clip.animIn, p);
    }
    if (clip.animOut && clip.animOut !== 'none' && local > dur - dout) {
      const p = Math.max(0, Math.min(1, (dur - local) / dout)); // 1 → 0 hacia el final
      this._mergeAnim(a, clip.animOut, p);
    }
    return a;
  }

  // q: 0 = extremo (oculto/fuera), 1 = posición normal. Aplica un easing suave.
  _mergeAnim(acc, type, q) {
    const e = 1 - Math.pow(1 - q, 3); // easeOutCubic
    const inv = 1 - e;
    switch (type) {
      case 'fade': acc.alpha *= e; break;
      case 'pop': acc.alpha *= Math.min(1, q * 2); acc.scale *= 0.35 + 0.65 * e; break;
      case 'zoom': acc.scale *= 1 + 0.4 * inv; acc.alpha *= Math.min(1, q * 1.5); break;
      case 'zoomout': acc.scale *= 1 - 0.35 * inv; acc.alpha *= Math.min(1, q * 1.5); break;
      case 'slidel': acc.alpha *= e; acc.dx += -inv; break;
      case 'slider': acc.alpha *= e; acc.dx += inv; break;
      case 'slideu': acc.alpha *= e; acc.dy += -inv; break;
      case 'slided': acc.alpha *= e; acc.dy += inv; break;
      case 'spin': acc.alpha *= e; acc.rot += inv * 180; acc.scale *= 0.6 + 0.4 * e; break;
      case 'bounce': { const b = Math.sin(q * Math.PI) * (1 - q); acc.dy += -0.12 * b; acc.alpha *= Math.min(1, q * 2); break; }
    }
  }

  // Interpola la transformación entre keyframes en el tiempo local del clip.
  _kfTransform(clip, local) {
    const kf = clip.keyframes;
    if (!kf || !kf.length) return null;
    if (kf.length === 1 || local <= kf[0].t) return kf[0];
    if (local >= kf[kf.length - 1].t) return kf[kf.length - 1];
    for (let i = 0; i < kf.length - 1; i++) {
      if (local >= kf[i].t && local <= kf[i + 1].t) {
        const a = kf[i], b = kf[i + 1];
        const p = (b.t - a.t) ? (local - a.t) / (b.t - a.t) : 0;
        const L = (x, y) => x + (y - x) * p;
        return { scale: L(a.scale, b.scale), offsetX: L(a.offsetX, b.offsetX), offsetY: L(a.offsetY, b.offsetY), rotate: L(a.rotate, b.rotate), opacity: L(a.opacity, b.opacity) };
      }
    }
    return kf[kf.length - 1];
  }

  // Recorta el color de chroma a transparente. Devuelve un canvas.
  _chromaProcess(clip, src, sw, sh, isImage) {
    const ch = clip.chroma;
    const key = `${ch.color}|${ch.similarity}|${ch.smooth}|${sw}x${sh}`;
    if (isImage) {
      const cached = this._chromaCache.get(clip.id);
      if (cached && cached.key === key) return cached.canvas;
    }
    const long = Math.max(sw, sh);
    const cap = isImage ? 1280 : 720; // limita el coste en video
    const scale = Math.min(1, cap / long);
    const w = Math.max(2, Math.round(sw * scale)), h = Math.max(2, Math.round(sh * scale));
    const canvas = isImage ? document.createElement('canvas') : this._chromaScratch;
    canvas.width = w; canvas.height = h;
    const cctx = canvas.getContext('2d', { willReadFrequently: true });
    cctx.clearRect(0, 0, w, h);
    cctx.drawImage(src, 0, 0, w, h);
    let img;
    try { img = cctx.getImageData(0, 0, w, h); } catch { return null; }
    const d = img.data;
    const kr = parseInt(ch.color.slice(1, 3), 16), kg = parseInt(ch.color.slice(3, 5), 16), kb = parseInt(ch.color.slice(5, 7), 16);
    const sim = ch.similarity, sm = Math.max(0.001, ch.smooth);
    for (let i = 0; i < d.length; i += 4) {
      const dr = d[i] - kr, dg = d[i + 1] - kg, db = d[i + 2] - kb;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db) / 441.673;
      if (dist < sim) d[i + 3] = 0;
      else if (dist < sim + sm) d[i + 3] = Math.round(d[i + 3] * ((dist - sim) / sm));
    }
    cctx.putImageData(img, 0, 0);
    if (isImage) this._chromaCache.set(clip.id, { key, canvas });
    return canvas;
  }

  // Tablas de 256 valores del clip, recalculadas solo cuando cambia la curva.
  _curveTables(clip) {
    const key = crvKey(clip.curves);
    const c = this._curveLUTs.get(clip.id);
    if (c && c.key === key) return c.t;
    const t = crvTables(clip.curves);
    this._curveLUTs.set(clip.id, { key, t });
    return t;
  }

  // Aplica las curvas píxel a píxel. Igual que el chroma: las fotos se cachean
  // y el video se limita en resolución para que la vista previa no se atasque.
  _curveProcess(clip, src, sw, sh, isImage) {
    const key = crvKey(clip.curves) + `|${sw}x${sh}`;
    if (isImage) {
      const cached = this._curveCache.get(clip.id);
      if (cached && cached.key === key) return cached.canvas;
    }
    const long = Math.max(sw, sh);
    const cap = isImage ? 1600 : (this._exporting ? 1440 : 720);
    const scale = Math.min(1, cap / long);
    const w = Math.max(2, Math.round(sw * scale)), h = Math.max(2, Math.round(sh * scale));
    const canvas = isImage ? document.createElement('canvas') : this._curveScratch;
    canvas.width = w; canvas.height = h;
    const cx = canvas.getContext('2d', { willReadFrequently: true });
    cx.clearRect(0, 0, w, h);
    cx.drawImage(src, 0, 0, w, h);
    let img;
    try { img = cx.getImageData(0, 0, w, h); } catch { return null; }
    const d = img.data;
    const { r, g, b } = this._curveTables(clip);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = r[d[i]]; d[i + 1] = g[d[i + 1]]; d[i + 2] = b[d[i + 2]];
    }
    cx.putImageData(img, 0, 0);
    if (isImage) this._curveCache.set(clip.id, { key, canvas });
    return canvas;
  }

  // Llamar cuando el usuario toca la curva de un clip.
  invalidateCurves(clipId) {
    this._curveCache.delete(clipId);
    this._curveLUTs.delete(clipId);
  }

  invalidateLens(clipId) { this._lensCache.delete(clipId); }

  // Tabla de remapeo de la lente: para cada píxel de salida, de qué píxel de
  // origen se toma el color. Se calcula UNA vez por tamaño e intensidad; luego
  // cada fotograma es solo copiar por índice, que es rapidísimo.
  _lensMap(w, h, k) {
    const clave = `${w}x${h}|${k.toFixed(3)}`;
    const hecho = this._lensMaps.get(clave);
    if (hecho) return hecho;
    const map = new Int32Array(w * h);
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const diag = Math.sqrt(cx * cx + cy * cy) || 1;
    const den = 1 + k;
    let i = 0;
    for (let y = 0; y < h; y++) {
      const dy = (y - cy) / diag;
      for (let x = 0; x < w; x++, i++) {
        const dx = (x - cx) / diag;
        const r = Math.sqrt(dx * dx + dy * dy);
        // r_src = r · (1 + k·r²) / (1 + k). En r = 1 vale 1 con cualquier k,
        // así que la esquina siempre cae en la esquina y no se abre un hueco.
        const f = r > 1e-6 ? ((1 + k * r * r) / den) : 1;
        let sx = Math.round(cx + dx * diag * f);
        let sy = Math.round(cy + dy * diag * f);
        if (sx < 0) sx = 0; else if (sx >= w) sx = w - 1;
        if (sy < 0) sy = 0; else if (sy >= h) sy = h - 1;
        map[i] = (sy * w + sx) * 4;
      }
    }
    if (this._lensMaps.size > 8) this._lensMaps.clear(); // no acumules tablas
    this._lensMaps.set(clave, map);
    return map;
  }

  _lensProcess(clip, src, sw, sh, isImage) {
    const k = (clip.lens / 100) * 0.6;
    const key = `${clip.lens}|${sw}x${sh}`;
    if (isImage) {
      const c = this._lensCache.get(clip.id);
      if (c && c.key === key) return c.canvas;
    }
    const long = Math.max(sw, sh);
    const cap = isImage ? 1600 : (this._exporting ? 1440 : 720);
    const escala = Math.min(1, cap / long);
    const w = Math.max(2, Math.round(sw * escala)), h = Math.max(2, Math.round(sh * escala));
    const canvas = isImage ? document.createElement('canvas') : this._lensScratch;
    canvas.width = w; canvas.height = h;
    const cx = canvas.getContext('2d', { willReadFrequently: true });
    cx.clearRect(0, 0, w, h);
    cx.drawImage(src, 0, 0, w, h);
    let img;
    try { img = cx.getImageData(0, 0, w, h); } catch { return null; }
    const d = img.data;
    const orig = new Uint8ClampedArray(d);
    const map = this._lensMap(w, h, k);
    for (let i = 0, p = 0; i < map.length; i++, p += 4) {
      const q = map[i];
      d[p] = orig[q]; d[p + 1] = orig[q + 1]; d[p + 2] = orig[q + 2]; d[p + 3] = orig[q + 3];
    }
    cx.putImageData(img, 0, 0);
    if (isImage) this._lensCache.set(clip.id, { key, canvas });
    return canvas;
  }

  // Desenfoque selectivo: deja nítida una zona y difumina el resto. Se hace
  // con una copia borrosa a la que se le «borra» la zona enfocada mediante un
  // degradado, así el original nítido asoma justo ahí.
  _applyFocus(f) {
    const W = this.canvas.width, H = this.canvas.height;
    const off = this._focusScratch;
    if (off.width !== W || off.height !== H) { off.width = W; off.height = H; }
    const octx = off.getContext('2d');
    const px = Math.max(1, (f.amount / 100) * Math.min(W, H) * 0.06);
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.globalCompositeOperation = 'source-over';
    octx.clearRect(0, 0, W, H);
    octx.filter = `blur(${px.toFixed(1)}px)`;
    octx.drawImage(this.canvas, 0, 0);
    octx.filter = 'none';

    const cx = (f.x ?? 50) / 100 * W, cy = (f.y ?? 50) / 100 * H;
    const tam = Math.max(0.04, (f.size ?? 45) / 100);
    let grad;
    if (f.mode === 'band') {
      // Franja horizontal nítida (efecto maqueta / tilt-shift).
      const mitad = tam * H * 0.5, suave = mitad * 0.9;
      grad = octx.createLinearGradient(0, cy - mitad - suave, 0, cy + mitad + suave);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(Math.max(0.001, suave / (2 * (mitad + suave))), 'rgba(0,0,0,1)');
      grad.addColorStop(Math.min(0.999, 1 - suave / (2 * (mitad + suave))), 'rgba(0,0,0,1)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
    } else {
      const radio = tam * Math.max(W, H) * 0.75;
      grad = octx.createRadialGradient(cx, cy, radio * 0.45, cx, cy, radio);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
    }
    octx.globalCompositeOperation = 'destination-out';
    octx.fillStyle = grad;
    octx.fillRect(0, 0, W, H);
    octx.globalCompositeOperation = 'source-over';

    const ctx = this.ctx;
    ctx.save();
    ctx.filter = 'none'; ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(off, 0, 0);
    ctx.restore();
  }

  _drawFit(src, sw, sh, cover, scale, tx, ty, rot, opts) {
    const W = this.canvas.width, H = this.canvas.height;
    const base = cover ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
    const w = sw * base * scale, h = sh * base * scale;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(W / 2 + tx, H / 2 + ty);
    if (rot) ctx.rotate(rot);
    if (opts && (opts.flipH || opts.flipV)) ctx.scale(opts.flipH ? -1 : 1, opts.flipV ? -1 : 1);
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
    if (opts && opts.mask) { this._maskPath(ctx, opts.mask, w, h); ctx.clip(); }
    else if (r > 0) { this._roundRect(ctx, -w / 2, -h / 2, w, h, r); ctx.clip(); }
    // Con recorte usamos la forma de 9 argumentos para tomar solo ese trozo.
    const sr = opts && opts.srcRect;
    if (sr) ctx.drawImage(src, sr.sx, sr.sy, sr.sw, sr.sh, -w / 2, -h / 2, w, h);
    else ctx.drawImage(src, -w / 2, -h / 2, w, h);
    // Borde de la superposición (se dibuja dentro del recorte, por eso el doble
    // de grosor: la mitad visible queda pegada al borde de la forma).
    if (opts && opts.border && opts.border.w > 0) {
      ctx.lineWidth = opts.border.w * 2 * Math.min(w, h);
      ctx.strokeStyle = opts.border.color;
      ctx.lineJoin = 'round';
      if (opts.mask) { this._maskPath(ctx, opts.mask, w, h); ctx.stroke(); }
      else if (r > 0) { this._roundRect(ctx, -w / 2, -h / 2, w, h, r); ctx.stroke(); }
      else ctx.strokeRect(-w / 2, -h / 2, w, h);
    }
    ctx.restore();
  }

  // Traza el contorno de una máscara de forma centrada en (0,0), tamaño w×h.
  _maskPath(ctx, mask, w, h) {
    ctx.beginPath();
    const rx = w / 2, ry = h / 2, s = Math.min(rx, ry);
    if (mask === 'circle') {
      ctx.ellipse(0, 0, s, s, 0, 0, Math.PI * 2);
    } else if (mask === 'oval') {
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    } else if (mask === 'roundrect') {
      this._roundRect(ctx, -rx, -ry, w, h, Math.min(rx, ry) * 0.35);
    } else if (mask === 'triangle') {
      ctx.moveTo(0, -s); ctx.lineTo(s * 0.92, s * 0.7); ctx.lineTo(-s * 0.92, s * 0.7); ctx.closePath();
    } else if (mask === 'star') {
      const spikes = 5, outer = s, inner = s * 0.45;
      for (let i = 0; i < spikes * 2; i++) {
        const rr = i % 2 === 0 ? outer : inner;
        const a = (Math.PI / spikes) * i - Math.PI / 2;
        const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
    } else if (mask === 'heart') {
      const u = s / 16;
      ctx.moveTo(0, 5 * u);
      ctx.bezierCurveTo(-2 * u, 1 * u, -8 * u, -1 * u, -8 * u, -5 * u);
      ctx.bezierCurveTo(-8 * u, -10 * u, -3 * u, -11 * u, 0, -6 * u);
      ctx.bezierCurveTo(3 * u, -11 * u, 8 * u, -10 * u, 8 * u, -5 * u);
      ctx.bezierCurveTo(8 * u, -1 * u, 2 * u, 1 * u, 0, 5 * u);
      ctx.closePath();
    } else if (mask === 'diamond') {
      ctx.moveTo(0, -ry); ctx.lineTo(rx, 0); ctx.lineTo(0, ry); ctx.lineTo(-rx, 0); ctx.closePath();
    } else if (mask === 'hexagon' || mask === 'pentagon') {
      const sides = mask === 'hexagon' ? 6 : 5;
      for (let i = 0; i < sides; i++) {
        const a = (Math.PI * 2 / sides) * i - Math.PI / 2;
        const x = Math.cos(a) * s, y = Math.sin(a) * s;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
    } else {
      ctx.rect(-rx, -ry, w, h);
    }
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
      case 'wipeup':
        this.drawClip(a, localA, {});
        this.drawClip(b, localB, { clipRect: { x: 0, y: 0, w: 1, h: p } });
        break;
      case 'wipedown':
        this.drawClip(a, localA, {});
        this.drawClip(b, localB, { clipRect: { x: 0, y: 1 - p, w: 1, h: p } });
        break;
      case 'zoomout':
        this.drawClip(a, localA, { scale: 1 + 0.5 * p, alpha: 1 - p });
        this.drawClip(b, localB, { alpha: p, scale: 0.85 + 0.15 * p });
        break;
      case 'whip': {
        const k = 1.15;
        this.drawClip(a, localA, { tx: -p * W * k, filter: `blur(${p * 14}px)` });
        this.drawClip(b, localB, { tx: (1 - p) * W * k, filter: `blur(${(1 - p) * 14}px)` });
        break;
      }
      case 'iris': {
        this.drawClip(a, localA, {});
        const R = Math.max(0.001, Math.hypot(W, H) / 2 * p);
        ctx.save();
        ctx.beginPath(); ctx.arc(W / 2, H / 2, R, 0, Math.PI * 2); ctx.clip();
        this.drawClip(b, localB, {});
        ctx.restore();
        break;
      }
      case 'glitch': {
        this.drawClip(a, localA, { alpha: 1 - p });
        const amp = (1 - Math.abs(p - 0.5) * 2) * 0.05 + 0.01;
        const j = (Math.random() - 0.5) * amp * W;
        this.drawClip(b, localB, { alpha: p, tx: j });
        break;
      }
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
    const back = (k) => { const c = k - 1; return 1 + 2.7 * c * c * c + 1.7 * c * c; }; // overshoot
    // Animaciones de entrada/salida.
    let alpha = 1, sx = 1, ty = 0, textOverride = null;
    const IN = Math.min(0.4, dur / 2), OUT = Math.min(0.4, dur / 2);
    if (tc.animIn !== 'none' && local < IN) {
      const k = Math.max(0, Math.min(1, local / IN));
      if (tc.animIn === 'fade') alpha = k;
      else if (tc.animIn === 'pop') { alpha = k; sx = 0.6 + 0.4 * k; }
      else if (tc.animIn === 'bounce') { alpha = Math.min(1, k * 2); sx = back(k); }
      else if (tc.animIn === 'slideup') { alpha = k; ty = (1 - k) * H * 0.08; }
      else if (tc.animIn === 'slidedown') { alpha = k; ty = -(1 - k) * H * 0.08; }
      else if (tc.animIn === 'typewriter') { const full = String(tc.text); textOverride = full.slice(0, Math.ceil(k * full.length)); }
    }
    if (tc.animOut !== 'none' && local > dur - OUT) {
      const k = Math.max(0, Math.min(1, (dur - local) / OUT));
      if (tc.animOut === 'fade') alpha = Math.min(alpha, k);
      else if (tc.animOut === 'pop' || tc.animOut === 'bounce') { alpha = Math.min(alpha, k); sx = 0.6 + 0.4 * k; }
      else if (tc.animOut === 'slideup') { alpha = Math.min(alpha, k); ty = -(1 - k) * H * 0.08; }
      else if (tc.animOut === 'slidedown') { alpha = Math.min(alpha, k); ty = (1 - k) * H * 0.08; }
    }

    const size = tc.size * (H / 1920);
    const font = FONTS[tc.font] || FONTS.sans;
    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.translate(tc.x * W, tc.y * H + ty);
    if (tc.rotate) ctx.rotate(tc.rotate * Math.PI / 180);
    ctx.scale(sx, sx);
    ctx.font = `${tc.bold ? '800' : '500'} ${size}px ${font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    try { ctx.letterSpacing = ((tc.letterSpacing || 0) * (H / 1920)) + 'px'; } catch {}
    const raw = String(textOverride != null ? textOverride : tc.text);
    const lines = tc.vertical ? [...raw].filter(c => c !== '\n') : raw.split('\n');
    const lineH = size * (tc.vertical ? 1.02 : 1.22);
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

    if (tc.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,.65)';
      ctx.shadowBlur = size * 0.28;
      ctx.shadowOffsetX = size * 0.05;
      ctx.shadowOffsetY = size * 0.09;
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

  // Reproduce un tramo en bucle: es lo que deja VER un efecto mientras lo
  // eliges (una transición, una animación de entrada…) sin tener que buscar
  // el momento a mano y darle a reproducir cada vez.
  loopRange(from, to) {
    const a = Math.max(0, Math.min(from, this.duration));
    const b = Math.max(a + 0.15, Math.min(to, this.duration));
    this.loopFrom = a; this.loopTo = b;
    this.pause();
    this.seek(a);
    this.playhead = a;
    this.play();
  }

  clearLoop() { this.loopFrom = this.loopTo = null; }

  tick() {
    if (!this.playing) return;
    const now = performance.now();
    const prate = this.previewRate || 1;
    let t = this.startPlayhead + ((now - this.startPerf) / 1000) * prate;
    // Reloj guiado por el vídeo: si la decodificación se atrasa, no dejamos que
    // el reloj adelante al fotograma real (evita el «tirón» al resincronizar).
    const lead = this._videoLeadTime();
    if (lead != null && t > lead + 0.05 * prate) {
      t = Math.max(this.playhead, lead + 0.05 * prate); // monótono: nunca retrocede
      this.startPerf = now; this.startPlayhead = t; // reancla el reloj de pared
    }
    // Bucle de vista previa: al llegar al final del tramo, vuelve al principio.
    if (this.loopTo != null && t >= this.loopTo) {
      const a = this.loopFrom || 0;
      this.playhead = a;
      this.seek(a);
      this.startPerf = now; this.startPlayhead = a;
      this.syncPlayback(a); this.render(a);
      this.onTick && this.onTick(a, false);
      this._raf = requestAnimationFrame(() => this.tick());
      return;
    }
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

  // Tiempo de línea que corresponde al fotograma actual del vídeo base activo,
  // o null si no aplica (imagen/texto, transición, vídeo no listo o pausado).
  _videoLeadTime() {
    const vs = videoStateAt(this.project.tracks.video, this.playhead);
    if (!vs || vs.b || !vs.a || vs.a.type !== 'video') return null;
    const clip = vs.a;
    const rec = this.elements.get(clip.id);
    if (!rec || !rec.el || !rec.ready || rec.el.paused || rec.el.seeking || rec.el.readyState < 2) return null;
    const start = this.playhead - vs.localA; // inicio del clip en la línea
    return start + (rec.el.currentTime - clip.inPoint) / (clip.speed || 1);
  }

  _audioEnv(clip, t, start, end) {
    let e = 1;
    if (clip.fadeIn > 0) e = Math.min(e, Math.max(0, (t - start) / clip.fadeIn));
    if (clip.fadeOut > 0) e = Math.min(e, Math.max(0, (end - t) / clip.fadeOut));
    return e * this._volCurve(clip, t - start);
  }

  // Curva de volumen dibujada a mano: puntos [segundo, multiplicador] en el
  // tiempo local del clip, unidos por rectas. Sin puntos, no hace nada.
  _volCurve(clip, local) {
    const p = clip.volPoints;
    if (!p || p.length < 1) return 1;
    if (p.length === 1) return p[0][1];
    if (local <= p[0][0]) return p[0][1];
    const ult = p[p.length - 1];
    if (local >= ult[0]) return ult[1];
    let lo = 0, hi = p.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (p[mid][0] <= local) lo = mid; else hi = mid - 1;
    }
    const a = p[lo], b = p[Math.min(p.length - 1, lo + 1)];
    const span = b[0] - a[0];
    const k = span > 1e-6 ? (local - a[0]) / span : 0;
    return a[1] + (b[1] - a[1]) * k;
  }

  // Ganancia del fundido del proyecto (baja el audio al aparecer/desaparecer).
  _projFadeGain(t) {
    const fi = this.project.fadeIn || 0, fo = this.project.fadeOut || 0;
    if (!fi && !fo) return 1;
    const total = projectDuration(this.project);
    let g = 1;
    if (fi > 0 && t < fi) g = Math.min(g, Math.max(0, t / fi));
    if (fo > 0 && t > total - fo) g = Math.min(g, Math.max(0, (total - t) / fo));
    return g;
  }

  // ¿Suena algo que NO sea música con ducking? (voz, audio del video, otro
  // audio normal). Sirve para bajar la música automáticamente.
  _otherAudioAt(t, vs) {
    if (vs) {
      for (const c of [vs.a, vs.b]) {
        if (c && c.type === 'video' && !c.muted && (c.volume ?? 1) > 0.02) return true;
      }
    }
    for (const c of this.project.tracks.audio) {
      if (c.duck || c.muted || (c.volume ?? 1) <= 0.02) continue;
      const d = c.outPoint - c.inPoint;
      if (t >= c.start && t < c.start + d) return true;
    }
    return false;
  }

  syncPlayback(t) {
    const vs = videoStateAt(this.project.tracks.video, t);
    const pf = this._projFadeGain(t);
    // Atenuación suave: si cambiara de golpe se oiría un "clic".
    const quiere = this._otherAudioAt(t, vs) ? (this.project.duckLevel ?? 0.25) : 1;
    const paso = 0.08;
    if (this._duck == null) this._duck = 1;
    this._duck += Math.max(-paso, Math.min(paso, quiere - this._duck));
    const duck = this._duck;
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
      const drift = rec.el.currentTime - expected;
      // Solo resincroniza si el vídeo va ADELANTADO o muy desfasado (corte,
      // scrubbing). Si solo va un poco atrasado (decodificación), NO saltamos:
      // el reloj guiado por vídeo ya espera al fotograma real.
      if (drift > 0.34 || drift < -0.7) { try { rec.el.currentTime = expected; } catch {} }
      rec.el.playbackRate = (clip.speed || 1) * (this.previewRate || 1);
      if (rec.el.paused) rec.el.play().catch(() => {});
      // Crossfade de audio durante transición.
      let g = this._vol(clip);
      if (vs && vs.b) g *= isB ? vs.p : (1 - vs.p);
      setClipGain(clip.id, g * pf);
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
        rec.el.playbackRate = this.previewRate || 1;
        if (rec.el.paused) rec.el.play().catch(() => {});
        setClipGain(clip.id, this._vol(clip) * this._audioEnv(clip, t, start, end) * pf * (clip.duck ? duck : 1));
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
        const odrift = rec.el.currentTime - expected;
        if (odrift > 0.34 || odrift < -0.7) { try { rec.el.currentTime = expected; } catch {} }
        rec.el.playbackRate = (clip.speed || 1) * (this.previewRate || 1);
        if (rec.el.paused) rec.el.play().catch(() => {});
        setClipGain(clip.id, this._vol(clip) * this._audioEnv(clip, t, start, end) * pf);
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

  // Miniatura del proyecto: se reduce a un lienzo pequeño antes de codificar.
  // Codificar la vista previa a tamaño completo en cada guardado bloqueaba el
  // hilo principal y provocaba tirones al editar.
  snapshot() {
    try {
      const src = this.previewCanvas;
      if (!src.width || !src.height) return null;
      const MAX = 240;
      const k = Math.min(1, MAX / Math.max(src.width, src.height));
      const c = this._thumbCanvas || (this._thumbCanvas = document.createElement('canvas'));
      c.width = Math.max(1, Math.round(src.width * k));
      c.height = Math.max(1, Math.round(src.height * k));
      const cx = c.getContext('2d');
      cx.drawImage(src, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.62);
    } catch { return null; }
  }

  // ==================== EXPORTAR EN ALTA RESOLUCIÓN ====================
  beginExport(w, h) {
    this._prevRate = this.previewRate; this.previewRate = 1; // el video final va a 1x
    this._prevCanvas = this.canvas; this._prevCtx = this.ctx;
    this._exporting = true;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    this.canvas = c; this.ctx = c.getContext('2d', { alpha: false });
    return c;
  }
  endExport() {
    this.previewRate = this._prevRate || 1;
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
