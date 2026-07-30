// timeline.js — Render e interacción de la línea de tiempo (táctil + zoom).

import { clipDuration, videoClipStart, projectDuration, videoLayout, overlayDuration } from './state.js';

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
    this._ignoreScroll = false;
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
  render() {
    if (!this.project) return;
    const total = Math.max(projectDuration(this.project), 3);
    this.root.style.width = (total * this.pps + window.innerWidth) + 'px';
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
      let tag = clip.type === 'image' ? '🖼️' : '🎬';
      if ((clip.speed || 1) !== 1) tag += ` ${(clip.speed).toFixed(clip.speed % 1 ? 1 : 0)}×`;
      if (clip.motion && clip.motion !== 'none') tag += ' ✦';
      if (clip.muted) tag += ' 🔇';
      this._addLabel(el, tag);
      this._addTrimHandles(el, clip, 'video');
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

  _renderOverlayTrack() {
    const track = this.trackEls.overlay;
    track.innerHTML = '';
    const clips = this.project.tracks.overlay || [];
    if (clips.length === 0) { track.appendChild(this._hint('🖼️ Overlay / PiP')); return; }
    clips.forEach((clip) => {
      const el = this._buildClip(clip, 'overlay', clip.start, overlayDuration(clip));
      this._addThumb(el, clip.mediaId);
      el.classList.add('type-overlay');
      this._addLabel(el, (clip.type === 'image' ? '🖼️ PiP' : '🎬 PiP') + (clip.muted ? ' 🔇' : ''));
      this._addTrimHandles(el, clip, 'overlay');
      this._makeMovable(el, clip, 'overlay');
      track.appendChild(el);
    });
  }

  _renderAudioTrack() {
    const track = this.trackEls.audio;
    track.innerHTML = '';
    const clips = this.project.tracks.audio;
    if (clips.length === 0) { track.appendChild(this._hint('🎵 Música / audio')); return; }
    clips.forEach((clip) => {
      const el = this._buildClip(clip, 'audio', clip.start, clip.outPoint - clip.inPoint);
      el.classList.add('type-audio');
      this._addLabel(el, (clip.muted ? '🔇 ' : '🎵 ') + (this._mediaName(clip.mediaId) || 'Audio'));
      this._addTrimHandles(el, clip, 'audio');
      this._makeMovable(el, clip, 'audio');
      track.appendChild(el);
    });
  }

  _renderTextTrack() {
    const track = this.trackEls.text;
    track.innerHTML = '';
    const clips = this.project.tracks.text;
    if (clips.length === 0) { track.appendChild(this._hint('🅣 Texto / stickers')); return; }
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
    el.addEventListener('click', (e) => { e.stopPropagation(); this.select(clip.id, track); });
    return el;
  }

  _mediaThumb(mediaId) { return (this.mediaThumbs && this.mediaThumbs.get(mediaId)) || null; }
  _mediaName(mediaId) { return (this.mediaNames && this.mediaNames.get(mediaId)) || null; }

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
      startX = e.clientX; orig = { ...clip };
      handle.setPointerCapture && handle.setPointerCapture(e.pointerId);
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

  // ---------------- Mover ----------------
  _makeMovable(el, clip, track) {
    let startX = 0, origStart = 0, moved = false;
    const down = (e) => {
      if (e.target.classList.contains('clip-handle')) return;
      startX = e.clientX; origStart = clip.start; moved = false;
      el.setPointerCapture && el.setPointerCapture(e.pointerId);
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
    if (this._ignoreScroll) { this._ignoreScroll = false; return; }
    if (this.isPlaying && this.isPlaying()) return;
    this.onScrub && this.onScrub(Math.max(0, this.scroll.scrollLeft / this.pps));
  }
  setPlayhead(time) { this._ignoreScroll = true; this.scroll.scrollLeft = time * this.pps; }
}
