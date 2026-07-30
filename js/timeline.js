// timeline.js — Render e interacción de la línea de tiempo (táctil).

import { clipDuration, videoClipStart, projectDuration } from './state.js';

export const PPS = 90; // píxeles por segundo

export class Timeline {
  constructor(opts) {
    this.root = opts.root;               // #timeline
    this.scroll = opts.scroll;           // #timeline-scroll
    this.trackEls = opts.trackEls;       // { video, audio, text }
    this.onSelect = opts.onSelect;       // (clip, track) | (null)
    this.onChange = opts.onChange;       // () => void  (persistir + recalcular)
    this.onScrub = opts.onScrub;         // (time) => void
    this.isPlaying = opts.isPlaying;     // () => bool
    this.project = null;
    this.selectedId = null;
    this.selectedTrack = null;
    this._ignoreScroll = false;

    this.scroll.addEventListener('scroll', () => this._onScroll(), { passive: true });
  }

  setProject(project) { this.project = project; this.render(); }

  select(id, track) {
    this.selectedId = id;
    this.selectedTrack = track;
    this._updateSelectionClasses();
    const clip = this._findSelected();
    this.onSelect && this.onSelect(clip, track);
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
    this.root.querySelectorAll('.clip').forEach(el => {
      el.classList.toggle('selected', el.dataset.id === this.selectedId);
    });
  }

  // ---------------- Render ----------------
  render() {
    if (!this.project) return;
    const total = Math.max(projectDuration(this.project), 3);
    this.root.style.width = (total * PPS + window.innerWidth) + 'px';

    this._renderVideoTrack();
    this._renderAudioTrack();
    this._renderTextTrack();
    this._updateSelectionClasses();
  }

  _renderVideoTrack() {
    const track = this.trackEls.video;
    track.innerHTML = '';
    const clips = this.project.tracks.video;
    if (clips.length === 0) {
      track.appendChild(this._hint('Toca «Añadir» para poner tu primer video o foto'));
      return;
    }
    clips.forEach((clip, i) => {
      const start = videoClipStart(clips, i);
      const el = this._buildClip(clip, 'video', start, clipDuration(clip));
      const media = this._mediaThumb(clip.mediaId);
      if (media) {
        const img = document.createElement('img');
        img.className = 'clip-thumb'; img.src = media; el.appendChild(img);
      }
      el.classList.add(clip.type === 'image' ? 'type-image' : 'type-video');
      const label = document.createElement('span');
      label.className = 'clip-label';
      label.textContent = clip.type === 'image' ? '🖼️' : '🎬';
      el.appendChild(label);
      this._addTrimHandles(el, clip, 'video');
      track.appendChild(el);
    });
  }

  _renderAudioTrack() {
    const track = this.trackEls.audio;
    track.innerHTML = '';
    const clips = this.project.tracks.audio;
    if (clips.length === 0) {
      track.appendChild(this._hint('🎵 Música / audio'));
      return;
    }
    clips.forEach((clip) => {
      const dur = clip.outPoint - clip.inPoint;
      const el = this._buildClip(clip, 'audio', clip.start, dur);
      el.classList.add('type-audio');
      const label = document.createElement('span');
      label.className = 'clip-label';
      label.textContent = '🎵 ' + (this._mediaName(clip.mediaId) || 'Audio');
      el.appendChild(label);
      this._addTrimHandles(el, clip, 'audio');
      this._makeMovable(el, clip, 'audio');
      track.appendChild(el);
    });
  }

  _renderTextTrack() {
    const track = this.trackEls.text;
    track.innerHTML = '';
    const clips = this.project.tracks.text;
    if (clips.length === 0) {
      track.appendChild(this._hint('🅣 Texto'));
      return;
    }
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

  _hint(text) {
    const s = document.createElement('span');
    s.className = 'track-empty-hint';
    s.textContent = text;
    return s;
  }

  _buildClip(clip, track, start, duration) {
    const el = document.createElement('div');
    el.className = 'clip';
    el.dataset.id = clip.id;
    el.dataset.track = track;
    el.style.left = (start * PPS) + 'px';
    el.style.width = Math.max(26, duration * PPS) + 'px';
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      this.select(clip.id, track);
    });
    return el;
  }

  _mediaThumb(mediaId) {
    return (this.mediaThumbs && this.mediaThumbs.get(mediaId)) || null;
  }
  _mediaName(mediaId) {
    return (this.mediaNames && this.mediaNames.get(mediaId)) || null;
  }

  // ---------------- Recorte (trim) ----------------
  _addTrimHandles(el, clip, track) {
    const left = document.createElement('div');
    left.className = 'clip-handle left';
    const right = document.createElement('div');
    right.className = 'clip-handle right';
    el.appendChild(left);
    el.appendChild(right);
    this._bindTrim(left, el, clip, track, 'left');
    this._bindTrim(right, el, clip, track, 'right');
  }

  _bindTrim(handle, el, clip, track, side) {
    let startX = 0, orig = null;
    const down = (e) => {
      e.preventDefault(); e.stopPropagation();
      this.select(clip.id, track);
      startX = (e.touches ? e.touches[0].clientX : e.clientX);
      orig = { ...clip };
      handle.setPointerCapture && handle.setPointerCapture(e.pointerId);
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    };
    const move = (e) => {
      const x = e.clientX;
      const dt = (x - startX) / PPS;
      this._applyTrim(clip, track, side, orig, dt, el);
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      this.onChange && this.onChange();
      this.render();
    };
    handle.addEventListener('pointerdown', down);
  }

  _applyTrim(clip, track, side, orig, dt, el) {
    const MIN = 0.2;
    if (track === 'video') {
      if (clip.type === 'image') {
        if (side === 'right') clip.imageDuration = Math.max(MIN, orig.imageDuration + dt);
        else clip.imageDuration = Math.max(MIN, orig.imageDuration - dt);
      } else {
        if (side === 'left') {
          clip.inPoint = Math.min(Math.max(0, orig.inPoint + dt), clip.outPoint - MIN);
        } else {
          clip.outPoint = Math.max(clip.inPoint + MIN, Math.min(orig.outPoint + dt, clip.srcDuration));
        }
      }
    } else if (track === 'audio') {
      if (side === 'left') {
        const ni = Math.min(Math.max(0, orig.inPoint + dt), clip.outPoint - MIN);
        clip.inPoint = ni;
        clip.start = Math.max(0, orig.start + (ni - orig.inPoint));
      } else {
        clip.outPoint = Math.max(clip.inPoint + MIN, Math.min(orig.outPoint + dt, clip.srcDuration));
      }
    } else if (track === 'text') {
      if (side === 'left') clip.start = Math.min(Math.max(0, orig.start + dt), clip.end - MIN);
      else clip.end = Math.max(clip.start + MIN, orig.end + dt);
    }
    // feedback visual inmediato
    const dur = track === 'video' ? clipDuration(clip)
      : track === 'audio' ? (clip.outPoint - clip.inPoint)
      : (clip.end - clip.start);
    const start = track === 'video' ? this._videoStartOf(clip)
      : track === 'audio' ? clip.start : clip.start;
    el.style.left = (start * PPS) + 'px';
    el.style.width = Math.max(26, dur * PPS) + 'px';
    if (track === 'video') this._reflowVideo();
  }

  _videoStartOf(clip) {
    const clips = this.project.tracks.video;
    const i = clips.indexOf(clip);
    return videoClipStart(clips, i);
  }

  // Recoloca los clips de video (son secuenciales) tras un cambio de duración.
  _reflowVideo() {
    const clips = this.project.tracks.video;
    const els = this.trackEls.video.querySelectorAll('.clip');
    clips.forEach((clip, i) => {
      const el = [...els].find(e => e.dataset.id === clip.id);
      if (el) el.style.left = (videoClipStart(clips, i) * PPS) + 'px';
    });
  }

  // ---------------- Mover (arrastrar cuerpo) ----------------
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
      const dt = (e.clientX - startX) / PPS;
      if (Math.abs(e.clientX - startX) > 4) moved = true;
      const dur = track === 'audio' ? (clip.outPoint - clip.inPoint) : (clip.end - clip.start);
      const ns = Math.max(0, origStart + dt);
      if (track === 'audio') clip.start = ns;
      else { const len = clip.end - clip.start; clip.start = ns; clip.end = ns + len; }
      el.style.left = (ns * PPS) + 'px';
      void dur;
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      if (moved) { this.onChange && this.onChange(); this.render(); }
    };
    el.addEventListener('pointerdown', down);
  }

  // ---------------- Scroll <-> tiempo ----------------
  _onScroll() {
    if (this._ignoreScroll) { this._ignoreScroll = false; return; }
    if (this.isPlaying && this.isPlaying()) return;
    const time = Math.max(0, this.scroll.scrollLeft / PPS);
    this.onScrub && this.onScrub(time);
  }

  setPlayhead(time) {
    this._ignoreScroll = true;
    this.scroll.scrollLeft = time * PPS;
  }
}
