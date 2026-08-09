// timeline.js — Render e interacción de la línea de tiempo (táctil + zoom).

import { clipDuration, videoClipStart, projectDuration, videoLayout, overlayDuration, overlayLayerCount } from './state.js';

export const PPS = 90; // píxeles por segundo (base, zoom = 1)

export class Timeline {
  constructor(opts) {
    this.root = opts.root;
    this.scroll = opts.scroll;
    this.trackEls = opts.trackEls;       // { video, overlay, audio, text }
    this.onSelect = opts.onSelect;
    this.onChange = opts.onChange;
    this.onScrub = opts.onScrub;
    this.onTransition = opts.onTransition;
    this.isPlaying = opts.isPlaying;
    this.getPlayhead = opts.getPlayhead;
    this.project = null;
    this.selectedId = null;
    this.selectedTrack = null;
    this._selfScrollAt = -1e9;
    this._pendingRender = 0;
    this._zoom = 1;
    this.scroll.addEventListener('scroll', () => this._onScroll(), { passive: true });
  }

  get pps() { return PPS * this._zoom; }

  setZoom(z, keepTime) {
    const t = keepTime != null ? keepTime : (this.scroll.scrollLeft / this.pps);
    this._zoom = Math.max(0.25, Math.min(4, z));
    this.render();
    this.setPlayhead(t);
    return this._zoom;
  }

  setProject(project) { this.project = project; this.render(); }

  select(id, track) {
    this.selectedId = id; this.selectedTrack = track;
    this._updateSelectionClasses();
    this.onSelect && this.onSelect(this._findSelected(), track);
  }
  clearSelection() {
    this.selectedId = null; this.selectedTrack = null;
    this._updateSelectionClasses();
    this.onSelect && this.onSelect(null, null);
  }
  _findSelected() {
    if (!this.selectedId || !this.project) return null;
    return (this.project.tracks[this.selectedTrack] || []).find(c => c.id === this.selectedId) || null;
  }
  _updateSelectionClasses() {
    this.root.querySelectorAll('.clip').forEach(el => el.classList.toggle('selected', el.dataset.id === this.selectedId));
  }

  // ---------------- Render ----------------
  // Agrupa varias peticiones de render en un solo repintado (evita rehacer el
  // DOM varias veces por gesto). Usa render() directo solo si hace falta ya.
  requestRender() {
    if (this._pendingRender) return;
    this._pendingRender = requestAnimationFrame(() => { this._pendingRender = 0; this.render(); });
  }

  render() {
    if (!this.project) return;
    if (this._pendingRender) { cancelAnimationFrame(this._pendingRender); this._pendingRender = 0; }
    const total = Math.max(projectDuration(this.project), 3);
    this.root.style.width = (total * this.pps + window.innerWidth) + 'px';
    this._renderRuler(total);
    this._renderVideoTrack();
    this._renderOverlayTrack();
    this._renderAudioTrack();
    this._renderTextTrack();
    this._updateSelectionClasses();
  }

  _renderVideoTrack() {
    const track = this.trackEls.video;
    track.innerHTML = '';
    const clips = this.project.tracks.video;
    if (clips.length === 0) { track.appendChild(this._hint('Toca «Añadir» para poner tu primer video o foto')); return; }
    const layout = videoLayout(clips);
    layout.forEach(({ clip, start }, i) => {
      const el = this._buildClip(clip, 'video', start, clipDuration(clip));
      this._addThumb(el, clip.mediaId);
      el.classList.add(clip.type === 'image' ? 'type-image' : 'type-video');
      let tag = clip.type === 'image' ? 'Foto' : 'Video';
      if ((clip.speed || 1) !== 1) tag += ` ${(clip.speed).toFixed(clip.speed % 1 ? 1 : 0)}×`;
      if (clip.motion && clip.motion !== 'none') tag += ' ✦';
      if (clip.muted) tag += ' · sin sonido';
      if (clip.stab && clip.stab.on) tag += ' ⛶';
      if (clip.curves) tag += ' ◠';
      this._addLabel(el, tag);
      this._addTrimHandles(el, clip, 'video');
      this._makeReorderable(el, clip);
      track.appendChild(el);
      if (i > 0) {
        const tr = clip.transition || { type: 'none' };
        const mk = document.createElement('button');
        mk.className = 'transition-marker' + (tr.type !== 'none' ? ' active' : '');
        mk.style.left = (start * this.pps) + 'px';
        mk.textContent = tr.type !== 'none' ? '◆' : '⇋';
        mk.title = 'Transición';
        mk.addEventListener('click', (e) => { e.stopPropagation(); this.onTransition && this.onTransition(clip, i); });
        track.appendChild(mk);
      }
    });
  }

  // Una fila por capa de superposición. La capa 0 se dibuja abajo del todo en
  // el video, así que aquí va la ÚLTIMA: en pantalla, arriba = encima.
  _renderOverlayTrack() {
    const cont = this.trackEls.overlay;
    cont.innerHTML = '';
    const clips = this.project.tracks.overlay || [];
    const capas = overlayLayerCount(this.project);
    if (clips.length === 0 && capas === 1) {
      const fila = document.createElement('div');
      fila.className = 'ov-row';
      fila.appendChild(this._hint('Superposición (video o foto encima)'));
      cont.appendChild(fila);
      return;
    }
    for (let capa = capas - 1; capa >= 0; capa--) {
      const fila = document.createElement('div');
      fila.className = 'ov-row';
      fila.dataset.layer = capa;
      if (capas > 1) {
        const et = document.createElement('span');
        et.className = 'ov-row-label';
        et.textContent = 'C' + (capa + 1);
        fila.appendChild(et);
      }
      const enCapa = clips.filter(c => (c.layer || 0) === capa);
      if (!enCapa.length) fila.appendChild(this._hint(capas > 1 ? 'Capa vacía' : 'Superposición (video o foto encima)'));
      for (const clip of enCapa) {
        const el = this._buildClip(clip, 'overlay', clip.start, overlayDuration(clip));
        this._addThumb(el, clip.mediaId);
        el.classList.add('type-overlay');
        this._addLabel(el, (capas > 1 ? 'C' + (capa + 1) : 'Encima') + (clip.muted ? ' · sin sonido' : ''));
        this._addTrimHandles(el, clip, 'overlay');
        this._makeMovable(el, clip, 'overlay');
        fila.appendChild(el);
      }
      cont.appendChild(fila);
    }
  }

  _renderAudioTrack() {
    const track = this.trackEls.audio;
    track.innerHTML = '';
    const clips = this.project.tracks.audio;
    if (clips.length === 0) { track.appendChild(this._hint('Música y audio')); return; }
    clips.forEach((clip) => {
      const el = this._buildClip(clip, 'audio', clip.start, clip.outPoint - clip.inPoint);
      el.classList.add('type-audio');
      const peaks = this._mediaPeaks(clip.mediaId);
      if (peaks) this._drawWave(el, clip, peaks);
      this._addLabel(el, (this._mediaName(clip.mediaId) || 'Audio')
        + (clip.muted ? ' · sin sonido' : '')
        + (clip.duck ? ' · baja con la voz' : ''));
      this._addTrimHandles(el, clip, 'audio');
      this._makeMovable(el, clip, 'audio');
      track.appendChild(el);
    });
  }

  _renderTextTrack() {
    const track = this.trackEls.text;
    track.innerHTML = '';
    const clips = this.project.tracks.text;
    if (clips.length === 0) { track.appendChild(this._hint('Texto y stickers')); return; }
    clips.forEach((clip) => {
      const el = this._buildClip(clip, 'text', clip.start, clip.end - clip.start);
      el.classList.add('type-text');
      const txt = document.createElement('span');
      txt.className = 'clip-txt';
      txt.textContent = clip.text || 'Texto';
      el.appendChild(txt);
      this._addTrimHandles(el, clip, 'text');
      this._makeMovable(el, clip, 'text');
      track.appendChild(el);
    });
  }

  _renderRuler(total) {
    const ruler = document.getElementById('timeline-ruler');
    if (!ruler) return;
    ruler.innerHTML = '';
    const targets = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
    let step = targets[targets.length - 1];
    for (const s of targets) { if (s * this.pps >= 58) { step = s; break; } }
    for (let t = 0; t <= total + step; t += step) {
      const tick = document.createElement('div');
      tick.className = 'ruler-tick';
      tick.style.left = (t * this.pps) + 'px';
      const label = document.createElement('span');
      const m = Math.floor(t / 60), s = t % 60;
      label.textContent = m ? `${m}:${String(Math.floor(s)).padStart(2, '0')}` : (step < 1 ? t.toFixed(1) : Math.round(t) + 's');
      tick.appendChild(label);
      ruler.appendChild(tick);
    }
    // Marcadores del proyecto (pines que se pueden tocar para saltar ahí).
    for (const mk of (this.project.markers || [])) {
      const pin = document.createElement('button');
      pin.className = 'ruler-marker';
      pin.style.left = (mk.t * this.pps) + 'px';
      pin.textContent = mk.beat ? '♪' : '▾';
      pin.title = 'Marcador · toca para saltar';
      pin.addEventListener('click', (e) => { e.stopPropagation(); this.onScrub && this.onScrub(mk.t); this.setPlayhead(mk.t); });
      ruler.appendChild(pin);
    }
  }

  _hint(text) { const s = document.createElement('span'); s.className = 'track-empty-hint'; s.textContent = text; return s; }
  _addLabel(el, text) { const l = document.createElement('span'); l.className = 'clip-label'; l.textContent = text; el.appendChild(l); }
  _addThumb(el, mediaId) {
    const m = this._mediaThumb(mediaId);
    if (m) { const img = document.createElement('img'); img.className = 'clip-thumb'; img.src = m; el.appendChild(img); }
  }

  _buildClip(clip, track, start, duration) {
    const el = document.createElement('div');
    el.className = 'clip';
    el.dataset.id = clip.id; el.dataset.track = track;
    el.style.left = (start * this.pps) + 'px';
    el.style.width = Math.max(26, duration * this.pps) + 'px';
    if (clip.locked) { el.classList.add('locked'); const lk = document.createElement('span'); lk.className = 'clip-lock'; lk.textContent = '🔒'; el.appendChild(lk); }
    el.addEventListener('click', (e) => { e.stopPropagation(); this.select(clip.id, track); });
    return el;
  }

  _mediaThumb(mediaId) { return (this.mediaThumbs && this.mediaThumbs.get(mediaId)) || null; }
  _mediaName(mediaId) { return (this.mediaNames && this.mediaNames.get(mediaId)) || null; }
  _mediaPeaks(mediaId) { return (this.mediaPeaks && this.mediaPeaks.get(mediaId)) || null; }

  // Dibuja la forma de onda del audio en el clip, respetando el recorte.
  // El lienzo se cachea por (medio + recorte + ancho): redibujar la onda en
  // cada render hacía que la línea de tiempo fuese muy lenta con audio.
  _drawWave(el, clip, peaks) {
    const wPx = Math.max(8, Math.round((clip.outPoint - clip.inPoint) * this.pps));
    const cw = Math.min(1200, wPx), ch = 34;
    if (!this._waveCache) this._waveCache = new Map();
    const key = `${clip.mediaId}|${(clip.inPoint || 0).toFixed(2)}|${(clip.outPoint || 0).toFixed(2)}|${cw}`;
    const hit = this._waveCache.get(key);
    if (hit) { el.insertBefore(this._copyCanvas(hit), el.firstChild); return; }
    const cv = document.createElement('canvas');
    cv.className = 'wave-canvas';
    cv.width = cw; cv.height = ch;
    const cx = cv.getContext('2d');
    const src = clip.srcDuration || clip.outPoint || 1;
    const n = peaks.length;
    const startB = Math.max(0, Math.floor((clip.inPoint || 0) / src * n));
    const endB = Math.max(startB + 1, Math.min(n, Math.floor((clip.outPoint || src) / src * n)));
    const span = endB - startB;
    const bars = Math.min(cw, 260);
    const bw = cw / bars;
    cx.fillStyle = 'rgba(255,255,255,.6)';
    for (let i = 0; i < bars; i++) {
      const b = startB + Math.floor((i / bars) * span);
      const amp = peaks[b] || 0;
      const bh = Math.max(1, amp * (ch - 3));
      cx.fillRect(i * bw, (ch - bh) / 2, Math.max(1, bw * 0.7), bh);
    }
    if (this._waveCache.size > 24) this._waveCache.clear();
    this._waveCache.set(key, cv);
    el.insertBefore(this._copyCanvas(cv), el.firstChild);
  }

  // Copia un lienzo (cloneNode NO copia el mapa de bits).
  _copyCanvas(src) {
    const c = document.createElement('canvas');
    c.className = src.className; c.width = src.width; c.height = src.height;
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }

  // ---------------- Recorte ----------------
  _addTrimHandles(el, clip, track) {
    const left = document.createElement('div'); left.className = 'clip-handle left';
    const right = document.createElement('div'); right.className = 'clip-handle right';
    el.append(left, right);
    this._bindTrim(left, el, clip, track, 'left');
    this._bindTrim(right, el, clip, track, 'right');
  }

  _bindTrim(handle, el, clip, track, side) {
    let startX = 0, orig = null;
    const down = (e) => {
      e.preventDefault(); e.stopPropagation();
      this.select(clip.id, track);
      if (clip.locked) return;
      startX = e.clientX; orig = { ...clip };
      try { handle.setPointerCapture && handle.setPointerCapture(e.pointerId); } catch {}
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    };
    const move = (e) => this._applyTrim(clip, track, side, orig, (e.clientX - startX) / this.pps, el);
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); this.onChange && this.onChange(); this.render(); };
    handle.addEventListener('pointerdown', down);
  }

  _applyTrim(clip, track, side, orig, dt, el) {
    const MIN = 0.2;
    if (track === 'video') {
      if (clip.type === 'image') {
        clip.imageDuration = Math.max(MIN, orig.imageDuration + (side === 'right' ? dt : -dt));
      } else if (side === 'left') {
        clip.inPoint = Math.min(Math.max(0, orig.inPoint + dt), clip.outPoint - MIN);
      } else {
        clip.outPoint = Math.max(clip.inPoint + MIN, Math.min(orig.outPoint + dt, clip.srcDuration));
      }
    } else if (track === 'overlay') {
      if (clip.type === 'image') {
        if (side === 'right') clip.imageDuration = Math.max(MIN, orig.imageDuration + dt);
        else { const nd = Math.max(MIN, orig.imageDuration - dt); clip.start = Math.max(0, orig.start + (orig.imageDuration - nd)); clip.imageDuration = nd; }
      } else if (side === 'left') {
        const ni = Math.min(Math.max(0, orig.inPoint + dt), clip.outPoint - MIN);
        clip.inPoint = ni; clip.start = Math.max(0, orig.start + (ni - orig.inPoint));
      } else {
        clip.outPoint = Math.max(clip.inPoint + MIN, Math.min(orig.outPoint + dt, clip.srcDuration));
      }
    } else if (track === 'audio') {
      if (side === 'left') { const ni = Math.min(Math.max(0, orig.inPoint + dt), clip.outPoint - MIN); clip.inPoint = ni; clip.start = Math.max(0, orig.start + (ni - orig.inPoint)); }
      else clip.outPoint = Math.max(clip.inPoint + MIN, Math.min(orig.outPoint + dt, clip.srcDuration));
    } else if (track === 'text') {
      if (side === 'left') clip.start = Math.min(Math.max(0, orig.start + dt), clip.end - MIN);
      else clip.end = Math.max(clip.start + MIN, orig.end + dt);
    }
    const dur = track === 'video' ? clipDuration(clip)
      : track === 'overlay' ? overlayDuration(clip)
      : track === 'audio' ? (clip.outPoint - clip.inPoint) : (clip.end - clip.start);
    const start = track === 'video' ? this._videoStartOf(clip) : clip.start;
    el.style.left = (start * this.pps) + 'px';
    el.style.width = Math.max(26, dur * this.pps) + 'px';
    if (track === 'video') this._reflowVideo();
  }

  _videoStartOf(clip) { const clips = this.project.tracks.video; return videoClipStart(clips, clips.indexOf(clip)); }
  _reflowVideo() {
    const clips = this.project.tracks.video;
    const els = [...this.trackEls.video.querySelectorAll('.clip')];
    clips.forEach((clip, i) => { const el = els.find(e => e.dataset.id === clip.id); if (el) el.style.left = (videoClipStart(clips, i) * this.pps) + 'px'; });
  }

  // Imán: ajusta un tiempo al borde de clip / playhead / inicio más cercano.
  _snap(time, excludeId) {
    const pts = [0];
    videoLayout(this.project.tracks.video).forEach(l => { pts.push(l.start, l.end); });
    for (const c of (this.project.tracks.overlay || [])) if (c.id !== excludeId) pts.push(c.start, c.start + overlayDuration(c));
    for (const c of this.project.tracks.audio) if (c.id !== excludeId) pts.push(c.start, c.start + (c.outPoint - c.inPoint));
    for (const c of this.project.tracks.text) if (c.id !== excludeId) pts.push(c.start, c.end);
    if (this.getPlayhead) pts.push(this.getPlayhead());
    const thr = 9 / this.pps;
    let best = null, bd = thr;
    for (const p of pts) { const d = Math.abs(time - p); if (d < bd) { bd = d; best = p; } }
    return best != null ? best : time;
  }

  // Reordenar clips de video arrastrándolos (al principio, al final, donde sea).
  // Solo cuando el clip está seleccionado (tócalo primero); así el resto del
  // tiempo el gesto sirve para desplazar la línea de tiempo.
  _makeReorderable(el, clip) {
    let startX = 0, moved = false, dx = 0, origLeft = 0, w = 0;
    const clips = this.project.tracks.video;
    const down = (e) => {
      if (e.target.classList.contains('clip-handle')) return;
      if (clip.id !== this.selectedId) { this.select(clip.id, 'video'); return; }
      if (clip.locked) return;
      startX = e.clientX; moved = false; dx = 0;
      origLeft = parseFloat(el.style.left) || 0; w = parseFloat(el.style.width) || 0;
      try { el.setPointerCapture && el.setPointerCapture(e.pointerId); } catch {}
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    };
    const move = (e) => {
      dx = e.clientX - startX;
      if (Math.abs(dx) > 5) moved = true;
      if (moved) { el.style.transform = `translateX(${dx}px)`; el.style.zIndex = '30'; el.classList.add('dragging'); }
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      el.style.transform = ''; el.style.zIndex = ''; el.classList.remove('dragging');
      if (!moved) return;
      const i = clips.indexOf(clip);
      const layout = videoLayout(clips);
      const draggedCenter = origLeft + dx + w / 2;
      let target = 0;
      for (let k = 0; k < clips.length; k++) {
        if (k === i) continue;
        const c = layout[k].start * this.pps + clipDuration(clips[k]) * this.pps / 2;
        if (c < draggedCenter) target++;
      }
      if (target !== i) { const [m] = clips.splice(i, 1); clips.splice(target, 0, m); this.onChange && this.onChange(); }
      this.render();
    };
    el.addEventListener('pointerdown', down);
  }

  // ---------------- Mover ----------------
  _makeMovable(el, clip, track) {
    let startX = 0, origStart = 0, moved = false;
    const down = (e) => {
      if (e.target.classList.contains('clip-handle')) return;
      if (clip.id !== this.selectedId) { this.select(clip.id, track); return; }
      if (clip.locked) return;
      startX = e.clientX; origStart = clip.start; moved = false;
      try { el.setPointerCapture && el.setPointerCapture(e.pointerId); } catch {}
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    };
    const move = (e) => {
      const dt = (e.clientX - startX) / this.pps;
      if (Math.abs(e.clientX - startX) > 4) moved = true;
      let ns = Math.max(0, origStart + dt);
      const len = track === 'text' ? (clip.end - clip.start) : 0;
      // Imán al mover: prueba a encajar el inicio o el fin del clip.
      const snapStart = this._snap(ns, clip.id);
      const dur = track === 'text' ? len : (track === 'audio' ? (clip.outPoint - clip.inPoint) : overlayDuration(clip));
      const snapEnd = this._snap(ns + dur, clip.id) - dur;
      if (Math.abs(snapStart - ns) <= Math.abs(snapEnd - ns)) ns = snapStart; else ns = Math.max(0, snapEnd);
      if (track === 'text') { clip.start = ns; clip.end = ns + len; }
      else clip.start = ns;
      el.style.left = (ns * this.pps) + 'px';
    };
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); if (moved) { this.onChange && this.onChange(); this.render(); } };
    el.addEventListener('pointerdown', down);
  }

  // ---------------- Scroll <-> tiempo ----------------
  _onScroll() {
    // Ignora los eventos que provoca nuestro propio setPlayhead. Se usa una
    // marca de tiempo (no un booleano de un solo uso): fijar scrollLeft puede
    // no emitir evento, y antes esa marca se quedaba puesta y se tragaba el
    // siguiente arrastre real del usuario.
    if (performance.now() - (this._selfScrollAt || -1e9) < 120) return;
    if (this.isPlaying && this.isPlaying()) return;
    this.onScrub && this.onScrub(Math.max(0, this.scroll.scrollLeft / this.pps));
  }
  setPlayhead(time) {
    const x = time * this.pps;
    if (Math.abs(this.scroll.scrollLeft - x) < 0.5) return; // evita trabajo inútil
    this._selfScrollAt = performance.now();
    this.scroll.scrollLeft = x;
  }
}
