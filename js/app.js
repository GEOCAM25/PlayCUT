// app.js — Controlador principal de PlayCUT (v2 Pro).

import {
  createProject, createVideoClip, createAudioClip, createTextClip, createOverlayClip,
  clipDuration, projectDuration, videoClipAt, formatTime,
  normalizeProject, RATIOS, videoClipStart, overlayDuration,
} from './state.js';
import * as db from './db.js';
import { importFile, loadMediaRecord, computePeaks } from './media.js';
import { Engine } from './engine.js';
import { Timeline } from './timeline.js';
import { exportProject, computeExportSize } from './exporter.js';
import { mediaToMp3 } from './audioextract.js';
import { encodeGif } from './gifencoder.js';
import * as perf from './perf.js';
import * as pro from './pro.js';
import * as tutorial from './tutorial.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const screens = { home: $('#screen-home'), editor: $('#screen-editor') };

const els = {
  projectList: $('#project-list'), emptyProjects: $('#empty-projects'),
  btnNew: $('#btn-new-project'), btnInstall: $('#btn-install'),
  btnBack: $('#btn-back'), btnUndo: $('#btn-undo'), btnRedo: $('#btn-redo'),
  btnRatio: $('#btn-ratio'), projectName: $('#project-name'),
  saveStatus: $('#save-status'), btnExport: $('#btn-export'),
  canvas: $('#preview'), previewEmpty: $('#preview-empty'),
  btnPlay: $('#btn-play'), timeCurrent: $('#time-current'), timeTotal: $('#time-total'),
  seek: $('#seek'), toolbarMain: $('#toolbar-main'), clipTools: $('#clip-tools'),
  fileMedia: $('#file-media'), fileOverlay: $('#file-overlay'), fileAudio: $('#file-audio'),
  btnSettings: $('#btn-settings'), btnZoomIn: $('#btn-zoom-in'), btnZoomOut: $('#btn-zoom-out'),
  toast: $('#toast'), backdrop: $('#sheet-backdrop'),
};

let engine = new Engine(els.canvas);
let timeline = null;
let project = null;
let saveTimer = null;
let deferredInstall = null;
const mediaThumbs = new Map();
const mediaNames = new Map();
const mediaPeaks = new Map();

// Calcula (una vez) la forma de onda de un audio y redibuja la línea de tiempo.
async function ensurePeaks(mediaId) {
  if (!mediaId || mediaPeaks.has(mediaId)) return;
  try {
    const peaks = await computePeaks(mediaId, 600);
    if (peaks) { mediaPeaks.set(mediaId, peaks); timeline && timeline.render(); }
  } catch { /* sin forma de onda, no pasa nada */ }
}

// Historial (deshacer / rehacer)
let history = [];
let historyIndex = -1;

const STICKERS = ['⭐', '🔥', '❤️', '😎', '💯', '👍', '🎉', '✨', '👀', '😂', '🤙', '💖'];

// ---------- Utilidades ----------
function toast(msg) {
  els.toast.textContent = msg; els.toast.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => els.toast.classList.remove('show'), 2200);
}
// Vibración háptica (donde el dispositivo lo permita).
function haptic(pattern) { try { navigator.vibrate && navigator.vibrate(pattern); } catch {} }

// Superposición de "trabajando…" para tareas que tardan (importar, convertir).
function busy(text, sub) {
  const el = $('#busy'); if (!el) return;
  $('#busy-text').textContent = text || 'Procesando…';
  $('#busy-sub').textContent = sub || '';
  el.classList.add('show');
}
function busyUpdate(sub) { const s = $('#busy-sub'); if (s) s.textContent = sub || ''; }
function busyDone() { const el = $('#busy'); if (el) el.classList.remove('show'); }

// ---------- PRO ----------
// Marca visualmente todo lo que lleva data-pro y decide si se puede usar.
function refreshProUI() {
  const on = pro.isPro();
  $$('[data-pro]').forEach(el => el.classList.toggle('pro-locked', !on));
  $$('.badge-pro').forEach(b => { if (b.dataset.keep !== '1' && b.textContent.trim() === 'PRO') b.hidden = on; });
  const locked = $('#pro-locked-view'), act = $('#pro-active-view');
  if (locked && act) {
    locked.hidden = on; act.hidden = !on;
    const c = $('#pro-code-shown'); if (c) c.textContent = on ? ('Código usado: ' + pro.proCode()) : '';
  }
}
// Puerta de acceso: si no hay PRO, abre la hoja y devuelve false.
function requirePro(feature) {
  if (pro.isPro()) return true;
  openSheet('sheet-pro');
  toast('«' + (pro.PRO_FEATURES[feature] || 'Esta función') + '» es PRO');
  haptic(20);
  return false;
}
function bindPro() {
  $('#pro-redeem').addEventListener('click', () => {
    const code = $('#pro-code').value.trim();
    if (pro.redeem(code)) {
      refreshProUI(); haptic([15, 40, 25]);
      toast('¡PRO activado! Ya tienes todas las funciones');
      $('#pro-code').value = '';
    } else {
      toast('Ese código no es válido');
      $('#pro-code').select();
    }
  });
  $('#pro-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#pro-redeem').click(); });
  $('#pro-revoke').addEventListener('click', () => {
    pro.revoke(); refreshProUI(); toast('PRO desactivado en este dispositivo');
  });
  $('#btn-pro').addEventListener('click', () => openSheet('sheet-pro'));
}

// ---------- Tutorial ----------
function bindTutorial() {
  $('#btn-tutorial').addEventListener('click', () => {
    closeSheets();
    setTimeout(() => tutorial.start(), 320);
  });
}
function showScreen(name) { for (const k in screens) screens[k].classList.toggle('active', k === name); }
function setActive(container, attr, value) {
  $$(`${container} [data-${attr}]`).forEach(b => b.classList.toggle('active', b.dataset[attr] === String(value)));
}

let lastThumbAt = 0;
function scheduleSave() {
  if (!project) return;
  setSaveState('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    // La miniatura solo se refresca de vez en cuando y nunca reproduciendo:
    // codificarla en cada guardado añadía trabajo al hilo principal.
    const now = Date.now();
    // Si el proyecto aún no tiene miniatura se genera ya; después basta con
    // refrescarla de vez en cuando (y nunca durante la reproducción).
    if (!project.thumb || (!engine.playing && now - lastThumbAt > 4000)) {
      lastThumbAt = now;
      project.thumb = engine.snapshot() || project.thumb;
    }
    project.updatedAt = now;
    try {
      await db.saveProject(project);
      setSaveState('saved');
    } catch (e) {
      console.error(e);
      setSaveState('error');
    }
  }, 700);
}
function setSaveState(state) {
  const el = els.saveStatus;
  el.dataset.state = state;
  el.textContent = state === 'saving' ? 'Guardando…'
    : state === 'error' ? '⚠ No se pudo guardar (¿sin espacio?)'
    : 'Guardado en este dispositivo ✓';
}

function refresh() {
  engine.recalc(); engine.syncElements(); engine.applyGains();
  timeline.render(); updateDurationUI(); updateEmptyState();
  engine.render(engine.playhead); scheduleSave();
}

function updateDurationUI() {
  els.timeTotal.textContent = formatTime(projectDuration(project));
  updateTimeUI(engine.playhead);
}
function updateTimeUI(t) {
  els.timeCurrent.textContent = formatTime(t);
  const total = projectDuration(project) || 1;
  els.seek.value = Math.round((t / total) * 1000);
}
function updateEmptyState() { els.previewEmpty.hidden = project.tracks.video.length !== 0; }

// Ajusta la altura de la vista previa al formato del proyecto: para videos
// anchos (16:9) la encoge para que suba la línea de tiempo y no queden huecos.
function fitPreview() {
  const wrap = document.querySelector('.preview-wrap');
  const tl = document.querySelector('.timeline-area');
  if (!project || !wrap) return;
  if (getComputedStyle(screens.editor).display === 'grid') { wrap.style.flex = ''; wrap.style.height = ''; if (tl) tl.style.flex = ''; return; }
  if (screens.editor.classList.contains('sheet-open')) return; // el CSS manda
  const aspect = project.width / project.height;
  if (aspect >= 1.05) {
    // Video ancho (16:9…): encoge el video y deja crecer la línea de tiempo
    // (solo uno crece a la vez para no romper el layout).
    const w = wrap.clientWidth || window.innerWidth;
    wrap.style.flex = '0 0 auto';
    wrap.style.height = Math.round(w / aspect) + 'px';
    if (tl) tl.style.flex = '1 1 auto';
  } else {
    wrap.style.flex = '1 1 auto';
    wrap.style.height = '';
    if (tl) tl.style.flex = '';
  }
  engine.render(engine.playhead);
}

// ---------- Historial ----------
function pushHistory() {
  if (!project) return;
  const snap = JSON.stringify(project);
  if (history[historyIndex] === snap) return;
  history = history.slice(0, historyIndex + 1);
  history.push(snap);
  if (history.length > 60) history.shift();
  historyIndex = history.length - 1;
  updateUndoButtons();
}
function resetHistory() { history = [JSON.stringify(project)]; historyIndex = 0; updateUndoButtons(); }
function updateUndoButtons() {
  els.btnUndo.disabled = historyIndex <= 0;
  els.btnRedo.disabled = historyIndex >= history.length - 1;
}
function restoreSnapshot(snap) {
  project = normalizeProject(JSON.parse(snap));
  engine.setProject(project);
  engine.onTick = tickHandler;
  timeline.setProject(project);
  timeline.clearSelection();
  onClipSelected(null);
  els.projectName.value = project.name;
  updateDurationUI(); updateEmptyState();
  engine.seek(Math.min(engine.playhead, projectDuration(project)));
  timeline.setPlayhead(engine.playhead);
  scheduleSave();
}
function undo() { if (historyIndex > 0) { historyIndex--; restoreSnapshot(history[historyIndex]); updateUndoButtons(); toast('Deshacer'); } }
function redo() { if (historyIndex < history.length - 1) { historyIndex++; restoreSnapshot(history[historyIndex]); updateUndoButtons(); toast('Rehacer'); } }

// ==================================================================
//  PROYECTOS
// ==================================================================
async function renderProjects() {
  const projects = await db.getAllProjects();
  els.projectList.innerHTML = '';
  els.emptyProjects.hidden = projects.length > 0;
  for (const p of projects) {
    normalizeProject(p);
    const card = document.createElement('div');
    card.className = 'project-card';
    const thumb = document.createElement('div');
    thumb.className = 'project-thumb';
    if (p.thumb) thumb.style.backgroundImage = `url(${p.thumb})`; else thumb.textContent = '🎬';
    const meta = document.createElement('div');
    meta.className = 'project-meta';
    meta.innerHTML = `<h3>${escapeHtml(p.name)}</h3><span>${formatTime(projectDuration(p))} · ${p.ratio} · ${new Date(p.updatedAt).toLocaleDateString()}</span>`;
    const actions = document.createElement('div');
    actions.className = 'project-actions';
    const dup = document.createElement('button');
    dup.className = 'project-act'; dup.textContent = '⧉'; dup.title = 'Duplicar';
    dup.addEventListener('click', async (e) => {
      e.stopPropagation();
      const copy = JSON.parse(JSON.stringify(p));
      copy.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      copy.name = p.name + ' (copia)'; copy.createdAt = Date.now();
      await db.saveProject(copy); renderProjects(); toast('Proyecto duplicado');
    });
    const del = document.createElement('button');
    del.className = 'project-act'; del.textContent = '×'; del.title = 'Borrar';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`¿Borrar "${p.name}"? Esto no se puede deshacer.`)) { await db.deleteProject(p.id); renderProjects(); toast('Proyecto borrado'); }
    });
    actions.append(dup, del);
    card.append(thumb, meta, actions);
    card.addEventListener('click', () => openProject(p.id));
    els.projectList.appendChild(card);
  }
  updateStorageUsage();
}

async function updateStorageUsage() {
  const el = $('#storage-usage'); if (!el) return;
  try {
    const { usage, quota } = await db.estimateStorage();
    if (quota) {
      const mb = (usage / 1048576).toFixed(0);
      const gb = (quota / 1073741824).toFixed(1);
      el.textContent = `📦 ${mb} MB usados en este dispositivo (de ~${gb} GB disponibles)`;
    } else el.textContent = '';
  } catch { el.textContent = ''; }
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function newProject() {
  const p = createProject('Proyecto ' + new Date().toLocaleDateString());
  await db.saveProject(p);
  await openProject(p.id);
}

// ==================================================================
//  EDITOR
// ==================================================================
function tickHandler(t, ended) {
  updateTimeUI(t); timeline.setPlayhead(t);
  if (ended) setPlayIcon(false);
}

async function openProject(id) {
  project = await db.getProject(id);
  if (!project) { toast('No se encontró el proyecto'); return; }
  normalizeProject(project);

  mediaThumbs.clear(); mediaNames.clear();
  const ids = new Set();
  for (const c of project.tracks.video) ids.add(c.mediaId);
  for (const c of project.tracks.overlay) ids.add(c.mediaId);
  for (const c of project.tracks.audio) ids.add(c.mediaId);
  for (const mid of ids) {
    const rec = await loadMediaRecord(mid);
    if (rec) { if (rec.thumb) mediaThumbs.set(mid, rec.thumb); mediaNames.set(mid, rec.name); }
  }

  engine.setProject(project);
  engine.onTick = tickHandler;
  engine.onClipUpdated = () => { timeline.render(); updateDurationUI(); fitPreview(); scheduleSave(); };
  engine.onMediaError = () => { toast('Un video no se pudo reproducir aquí. Si es de iPhone, prueba grabarlo en «Más compatible» (H.264/MP4).'); };
  timeline.mediaThumbs = mediaThumbs; timeline.mediaNames = mediaNames; timeline.mediaPeaks = mediaPeaks;
  timeline.setProject(project); timeline.clearSelection();
  onClipSelected(null);
  // Precalcula las formas de onda de los audios ya presentes en el proyecto.
  for (const a of project.tracks.audio) ensurePeaks(a.mediaId);

  els.projectName.value = project.name;
  updateDurationUI(); updateEmptyState();
  engine.seek(0); timeline.setPlayhead(0);
  lastThumbAt = 0; // cada proyecto genera su propia miniatura al primer guardado
  resetHistory();
  showScreen('editor');
  fitPreview();
  showTipsOnce();
}

// La primera vez que se abre el editor se lanza la guía guiada; después
// queda siempre disponible en Ajustes.
function showTipsOnce() {
  if (localStorage.getItem('playcut.tips')) return;
  localStorage.setItem('playcut.tips', '1');
  if (tutorial.tutorialSeen()) return;
  setTimeout(() => tutorial.start(), 700);
}

// Cambia el símbolo de un botón sin destruir su <svg> (usar textContent lo
// borraría y el botón se quedaría vacío).
function setIcon(el, id) {
  if (!el) return;
  const use = el.querySelector('use');
  if (use) use.setAttribute('href', '#ic-' + id);
}
function setPlayIcon(playing) {
  setIcon(els.btnPlay, playing ? 'pause' : 'play');
  els.btnPlay.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
}
function togglePlay() {
  if (engine.playing) { engine.pause(); setPlayIcon(false); }
  else { if (projectDuration(project) <= 0) { toast('Añade contenido primero'); return; } engine.play(); setPlayIcon(true); }
}

async function handleMediaFiles(files) {
  if (!files.length) return;
  pushHistory();
  engine.pause(); setPlayIcon(false);
  busy(files.length > 1 ? `Importando ${files.length} archivos…` : 'Importando…', 'Todo se queda en tu dispositivo');
  let added = 0, lastVideo = null;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (files.length > 1) busyUpdate(`${i + 1} de ${files.length} · ${file.name || ''}`);
    try {
      const rec = await importFile(file);
      if (rec.thumb) mediaThumbs.set(rec.id, rec.thumb);
      mediaNames.set(rec.id, rec.name);
      if (rec.kind === 'audio') {
        project.tracks.audio.push(createAudioClip({ mediaId: rec.id, duration: rec.duration || 5, start: engine.playhead, name: rec.name }));
        ensurePeaks(rec.id);
      } else {
        const clip = createVideoClip({ mediaId: rec.id, type: rec.kind, duration: rec.duration || 0, width: rec.width, height: rec.height });
        if (rec.kind === 'image') clip.imageDuration = defaultImageDur();
        project.tracks.video.push(clip); lastVideo = clip;
      }
      added++;
    } catch (e) {
      console.error(e);
      const quota = /quota|exceeded|storage|space|full/i.test((e && (e.name + ' ' + e.message)) || '');
      toast(quota ? 'No hay espacio en el dispositivo para ese archivo' : ('No se pudo importar ' + (file.name || 'el archivo')));
    }
  }
  busyDone();
  refresh();
  void lastVideo;
  pushHistory();
  if (added) toast('¡Añadido! Toca el clip para editarlo o pellízcalo con 2 dedos');
}

async function handleOverlayFiles(files) {
  if (!files.length) return;
  pushHistory();
  busy('Importando superposición…');
  let last = null;
  for (const file of files) {
    try {
      const rec = await importFile(file);
      if (rec.kind === 'audio') { toast('La superposición no admite audio suelto'); continue; }
      if (rec.thumb) mediaThumbs.set(rec.id, rec.thumb);
      mediaNames.set(rec.id, rec.name);
      const clip = createOverlayClip({ mediaId: rec.id, type: rec.kind, duration: rec.duration || 0, width: rec.width, height: rec.height, start: engine.playhead });
      project.tracks.overlay.push(clip); last = clip;
    } catch (e) { console.error(e); toast('No se pudo importar ' + file.name); }
  }
  busyDone();
  refresh(); pushHistory();
  if (last) { timeline.select(last.id, 'overlay'); toast('Superposición añadida — muévela y ajústala'); }
}

// Importa audio. Si es un VIDEO, extrae su audio y lo convierte a MP3.
async function handleAudioFiles(files) {
  if (!files.length) return;
  pushHistory();
  engine.pause(); setPlayIcon(false);
  busy('Añadiendo audio…');
  for (const file of files) {
    try {
      let audioFile = file;
      if (file.type.startsWith('video')) {
        busy('Extrayendo el audio del video…', 'Convirtiendo a MP3 en tu dispositivo');
        const mp3 = await mediaToMp3(file, (p) => {
          if (typeof p === 'number' && isFinite(p)) busyUpdate(`Convirtiendo a MP3 · ${Math.round(p * 100)}%`);
        });
        const base = (file.name.replace(/\.[^.]+$/, '') || 'audio');
        audioFile = new File([mp3], base + '.mp3', { type: 'audio/mpeg' });
      }
      busy('Añadiendo audio…');
      const rec = await importFile(audioFile);
      mediaNames.set(rec.id, rec.name);
      project.tracks.audio.push(createAudioClip({ mediaId: rec.id, duration: rec.duration || 5, start: engine.playhead, name: rec.name }));
      ensurePeaks(rec.id);
    } catch (e) { console.error(e); toast('No se pudo procesar el audio: ' + (e.message || '')); }
  }
  busyDone();
  refresh(); pushHistory(); toast('¡Audio añadido!');
}

// ==================================================================
//  BARRAS
// ==================================================================
function bindToolbar() {
  els.toolbarMain.addEventListener('click', (e) => {
    const btn = e.target.closest('.tool'); if (!btn) return;
    switch (btn.dataset.action) {
      case 'add-media': els.fileMedia.click(); break;
      case 'add-overlay': els.fileOverlay.click(); break;
      case 'add-audio': els.fileAudio.click(); break;
      case 'voice': openVoiceSheet(); break;
      case 'add-text': addTextAtPlayhead(false); break;
      case 'add-sticker': openStickerSheet(); break;
      case 'add-gif': openGifSheet(); break;
      case 'ratio': openRatioSheet(); break;
      case 'split': splitAtPlayhead(); break;
      case 'freeze': freezeFrame(); break;
      case 'paste': pasteClip(); break;
      case 'add-color': openSheet('sheet-color'); break;
      case 'marker': toggleMarker(); break;
      case 'beat': if (requirePro('beat')) beatMarkers(); break;
      case 'safe': if (requirePro('safe')) toggleSafeZones(); break;
      case 'grab-frame': if (requirePro('frame')) grabFrame(); break;
      case 'histogram': if (requirePro('histogram')) toggleHistogram(); break;
    }
  });

  els.clipTools.addEventListener('click', (e) => {
    const btn = e.target.closest('.tool'); if (!btn) return;
    const sel = getSelectedClip(); if (!sel) return;
    switch (btn.dataset.action) {
      case 'clip-adjust':
        if (sel.track === 'text') openTextSheet(sel.clip);
        else if (sel.track === 'audio') openAdjustSheet(sel.clip, 'audio');
        else openAdjustSheet(sel.clip, sel.track);
        break;
      case 'clip-audio':
        if (sel.clip.type === 'video' || sel.track === 'audio') openAudioSheet(sel.clip);
        else toast('Este clip no tiene audio');
        break;
      case 'clip-speed':
        if ((sel.track === 'video' || sel.track === 'overlay') && sel.clip.type === 'video') openSpeedSheet(sel.clip);
        else toast('La velocidad solo aplica a clips de video');
        break;
      case 'clip-transition':
        if (sel.track === 'video') openTransitionForClip(sel.clip);
        else toast('Las transiciones son entre clips de video');
        break;
      case 'clip-anim':
        if (sel.track === 'text') openTextSheet(sel.clip);
        else if (sel.track === 'video' || sel.track === 'overlay') openAdjustSheet(sel.clip, sel.track);
        else toast('Sin animación para este clip');
        break;
      case 'clip-split': splitAtPlayhead(); break;
      case 'clip-duplicate': duplicateClip(sel); break;
      case 'clip-copy': copyClip(sel); break;
      case 'clip-lock': toggleLock(sel); break;
      case 'clip-left': moveClip(sel, -1); break;
      case 'clip-right': moveClip(sel, 1); break;
      case 'clip-delete': deleteClip(sel); break;
    }
  });
}

function getSelectedClip() {
  if (!timeline.selectedId) return null;
  const track = timeline.selectedTrack;
  const clip = (project.tracks[track] || []).find(c => c.id === timeline.selectedId);
  return clip ? { clip, track } : null;
}

const EMOJI_CATS = {
  '😀': ['😀', '😃', '😄', '😁', '😅', '😂', '🤣', '😊', '😇', '🙂', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😝', '🤪', '😎', '🤩', '🥳', '😏', '😒', '😔', '😪', '😴', '😌', '😜', '🤔', '🤨', '😐', '😑', '🙄', '😬', '😲', '😳', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '😱', '😨', '😰', '😥', '🤗', '🤭', '🤫', '🤥', '😷', '🤒', '🤕', '🤢', '🤮', '🥵', '🥶', '😵', '🤯', '🤠', '🥸', '😈', '👿', '💀', '👻', '👽', '🤖'],
  '👍': ['👍', '👎', '👌', '🤌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '✋', '🤚', '🖐️', '🖖', '👋', '🤝', '👏', '🙌', '👐', '🙏', '✍️', '💪', '🦾', '👀', '👁️', '👂', '👃', '🧠', '🦷', '👅', '👄', '💋'],
  '❤️': ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '♥️', '💯', '💢', '💥', '💫', '💦', '💨', '🕳️', '💬', '💭', '🔥', '✨', '⭐', '🌟'],
  '🎉': ['🎉', '🎊', '🎈', '🎁', '🎂', '🍰', '🎄', '🎃', '🎆', '🎇', '🧨', '✨', '🎀', '🎗️', '🏆', '🥇', '🥈', '🥉', '🏅', '👑', '💎', '💍', '💰', '💵', '🎯', '🎮', '🕹️', '🎲', '🎸', '🎹', '🎤', '🎧', '🎬', '📷', '📸', '📱'],
  '🐶': ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🐤', '🦄', '🐝', '🦋', '🐢', '🐙', '🦈', '🐬', '🐳', '🌵', '🌴', '🌲', '🌸', '🌼', '🌻', '🌈', '☀️', '🌙', '⭐', '⚡', '❄️', '🔥', '💧', '🌊'],
  '🍕': ['🍕', '🍔', '🌭', '🌮', '🌯', '🍟', '🍿', '🥪', '🥗', '🍣', '🍜', '🍝', '🍩', '🍪', '🍫', '🍬', '🍭', '🍦', '🍨', '🎂', '🍎', '🍌', '🍓', '🍒', '🍑', '🍍', '🥑', '☕', '🍵', '🧋', '🥤', '🍺', '🍻', '🍷', '🥂', '⚽', '🏀', '🏈', '⚾', '🎾', '🚗', '✈️'],
  '💬': ['✅', '❌', '❓', '❗', '⁉️', '💤', '🔔', '📌', '📍', '🚩', '🏁', '⚠️', '🚫', '💯', '🆗', '🆒', '🔝', '➡️', '⬅️', '⬆️', '⬇️', '↗️', '↘️', '🔗', '➕', '➖', '✖️', '➗', '💲', '©️', '®️', '™️', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫', '⚪'],
};
const EMOJI_CAT_NAMES = { '😀': 'Caras', '👍': 'Gestos', '❤️': 'Amor', '🎉': 'Fiesta', '🐶': 'Animales', '🍕': 'Comida', '💬': 'Símbolos' };
let emojiCat = '😀';
function buildEmojiGrid() {
  const tabs = $('#emoji-tabs');
  if (tabs && !tabs.childElementCount) {
    for (const key of Object.keys(EMOJI_CATS)) {
      const b = document.createElement('button');
      b.className = 'chip'; b.type = 'button'; b.textContent = key; b.title = EMOJI_CAT_NAMES[key] || '';
      b.addEventListener('click', () => { emojiCat = key; renderEmojiGrid(); });
      tabs.appendChild(b);
    }
  }
  renderEmojiGrid();
}
function renderEmojiGrid() {
  const grid = $('#emoji-grid'); if (!grid) return;
  grid.innerHTML = '';
  $$('#emoji-tabs .chip').forEach(c => c.classList.toggle('active', c.textContent === emojiCat));
  for (const e of (EMOJI_CATS[emojiCat] || [])) {
    const b = document.createElement('button');
    b.className = 'emoji-item'; b.textContent = e; b.type = 'button';
    b.addEventListener('click', () => addSticker(e));
    grid.appendChild(b);
  }
}
function openStickerSheet() { buildEmojiGrid(); openSheet('sheet-sticker'); }
function addSticker(emoji) {
  pushHistory();
  const start = engine.playhead;
  const total = projectDuration(project);
  const end = Math.min(start + 3, total > start ? total : start + 3);
  const clip = createTextClip({ text: emoji, start, end: end > start ? end : start + 3, sticker: true });
  project.tracks.text.push(clip);
  refresh(); pushHistory(); timeline.select(clip.id, 'text'); closeSheets();
  haptic(10); toast('Sticker añadido — arrástralo o pellízcalo para cambiar tamaño');
}

function addTextAtPlayhead(sticker) {
  pushHistory();
  const start = engine.playhead;
  const total = projectDuration(project);
  const end = Math.min(start + 3, total > start ? total : start + 3);
  const clip = createTextClip({ text: sticker ? STICKERS[Math.floor(Math.random() * STICKERS.length)] : 'Toca para editar', start, end: end > start ? end : start + 3, sticker });
  project.tracks.text.push(clip);
  refresh();
  timeline.select(clip.id, 'text');
  openTextSheet(clip);
}

function splitAtPlayhead() {
  const t = engine.playhead;
  const clips = project.tracks.video;
  const at = videoClipAt(clips, t);
  if (!at || at.localTime < 0.15 || clipDuration(at.clip) - at.localTime < 0.15) { toast('Coloca el cursor dentro de un clip'); return; }
  pushHistory();
  const original = at.clip;
  const copy = JSON.parse(JSON.stringify(original));
  copy.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  copy.transition = { type: 'none', duration: 0.6 };
  if (original.type === 'video') {
    const cut = original.inPoint + at.localTime * (original.speed || 1);
    copy.inPoint = cut; copy.outPoint = original.outPoint; original.outPoint = cut;
  } else {
    const full = original.imageDuration; original.imageDuration = at.localTime; copy.imageDuration = Math.max(0.2, full - at.localTime);
  }
  clips.splice(at.index + 1, 0, copy);
  refresh(); timeline.select(copy.id, 'video'); haptic(15); toast('Clip dividido');
}

// Marcadores: añade o quita un pin en la posición del cursor.
function toggleMarker() {
  if (!project.markers) project.markers = [];
  const t = engine.playhead;
  const i = project.markers.findIndex(m => Math.abs(m.t - t) < 0.25);
  if (i >= 0) { project.markers.splice(i, 1); toast('Marcador quitado'); }
  else { project.markers.push({ t }); project.markers.sort((a, b) => a.t - b.t); toast('📍 Marcador añadido'); }
  timeline.render(); scheduleSave(); haptic(10);
}

// Guías de encuadre seguro (lo que tapan TikTok / Reels / Shorts).
function toggleSafeZones() {
  engine.showSafeZones = !engine.showSafeZones;
  engine.render(engine.playhead);
  const btn = $('#toolbar-main [data-action="safe"]');
  if (btn) btn.classList.toggle('tool-on', engine.showSafeZones);
  haptic(10);
  toast(engine.showSafeZones
    ? 'Guías activadas — deja lo importante dentro del recuadro'
    : 'Guías desactivadas');
}

// Histograma en vivo (herramienta de colorista): muestra el reparto de luces
// y sombras del fotograma. Solo se ve en la app, nunca sale en el video.
function toggleHistogram() {
  const cv = $('#histogram');
  const on = cv.hidden;
  cv.hidden = !on;
  engine.histogramCanvas = on ? cv : null;
  engine._histAt = 0;
  const btn = $('#toolbar-main [data-action="histogram"]');
  if (btn) btn.classList.toggle('tool-on', on);
  engine.render(engine.playhead);
  haptic(10);
  toast(on ? 'Histograma activado — mira si el video está quemado u oscuro' : 'Histograma desactivado');
}

// Guarda el fotograma actual como foto PNG (a resolución del proyecto).
async function grabFrame() {
  try {
    busy('Guardando la foto…');
    const blob = await engine.captureBaseFrame();
    busyDone();
    if (!blob) { toast('Coloca el cursor sobre un video o foto'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${sanitize(project.name)}_foto.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    haptic(15); toast('📷 Foto del fotograma guardada');
  } catch (e) { busyDone(); console.error(e); toast('No se pudo guardar la foto'); }
}

// Marcadores automáticos al ritmo de la música: busca los golpes fuertes
// en la forma de onda del primer audio y deja un pin en cada uno.
function beatMarkers() {
  const audio = project.tracks.audio[0];
  if (!audio) { toast('Añade primero una música para detectar su ritmo'); return; }
  const peaks = mediaPeaks.get(audio.mediaId);
  if (!peaks) { toast('Analizando la música… inténtalo en un segundo'); ensurePeaks(audio.mediaId); return; }
  const src = audio.srcDuration || (audio.outPoint - audio.inPoint) || 1;
  const n = peaks.length;
  const from = Math.max(0, Math.floor((audio.inPoint || 0) / src * n));
  const to = Math.min(n, Math.ceil((audio.outPoint || src) / src * n));
  const span = Math.max(1, to - from);
  // Media de la zona usada; un golpe es un pico claramente sobre la media.
  let sum = 0;
  for (let i = from; i < to; i++) sum += peaks[i];
  const avg = sum / span;
  const thr = Math.max(0.22, avg * 1.6);
  const secPerBucket = (audio.outPoint - audio.inPoint) / span;
  const MIN_GAP = 0.28; // no marcamos dos golpes casi pegados
  pushHistory();
  if (!project.markers) project.markers = [];
  let added = 0, lastT = -99;
  for (let i = from + 1; i < to - 1; i++) {
    const v = peaks[i];
    if (v < thr || v < peaks[i - 1] || v < peaks[i + 1]) continue;
    const t = audio.start + (i - from) * secPerBucket;
    if (t - lastT < MIN_GAP) continue;
    if (project.markers.some(m => Math.abs(m.t - t) < 0.2)) { lastT = t; continue; }
    project.markers.push({ t, beat: true });
    lastT = t; added++;
    if (added >= 120) break;
  }
  project.markers.sort((a, b) => a.t - b.t);
  timeline.render(); scheduleSave(); pushHistory();
  haptic(added ? [12, 30, 12] : 8);
  toast(added ? `🎵 ${added} marcadores puestos al ritmo` : 'No se detectaron golpes claros en la música');
}

// Tarjeta de color: genera una imagen sólida y la añade al final del video.
function bindColorCard() {
  $('#color-card-swatches').addEventListener('click', (e) => {
    const sw = e.target.closest('.swatch'); if (!sw) return;
    addColorCard(sw.dataset.color);
  });
  $('#btn-add-intro').addEventListener('click', addIntro);
  $('#btn-add-outro').addEventListener('click', addOutro);
  $('#proj-presets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]'); if (!b) return;
    applyProjectPreset(b.dataset.preset);
  });
}

// Estilos de proyecto: dejan todo el video con un mismo acabado de un toque.
const PROJECT_PRESETS = {
  reel: {
    nombre: 'Reel dinámico', ratio: '9:16',
    clip: { filter: 'vivid', motion: 'zoomIn', animIn: 'pop', animInDur: 0.4, temp: 8, vignette: 12, grain: 0 },
    transition: { type: 'whip', duration: 0.4 },
    fadeIn: 0.2, fadeOut: 0.5,
  },
  cine: {
    nombre: 'Cine', ratio: '16:9',
    clip: { filter: 'cine', motion: 'panR', animIn: 'fade', animInDur: 0.8, temp: -6, vignette: 38, grain: 22 },
    transition: { type: 'dissolve', duration: 0.9 },
    fadeIn: 1, fadeOut: 1.2,
  },
  vlog: {
    nombre: 'Vlog limpio', ratio: '9:16',
    clip: { filter: 'sharp', motion: 'none', animIn: 'fade', animInDur: 0.3, temp: 4, vignette: 0, grain: 0 },
    transition: { type: 'fadeblack', duration: 0.35 },
    fadeIn: 0.3, fadeOut: 0.6,
  },
};
function applyProjectPreset(key) {
  const p = PROJECT_PRESETS[key];
  if (!p) return;
  pushHistory();
  // Formato del lienzo
  if (RATIOS[p.ratio]) {
    const [w, h] = RATIOS[p.ratio];
    project.ratio = p.ratio; project.width = w; project.height = h;
  }
  project.fadeIn = p.fadeIn; project.fadeOut = p.fadeOut;
  // Acabado de cada clip (respeta los que estén bloqueados)
  const vids = project.tracks.video;
  vids.forEach((c, i) => {
    if (c.locked) return;
    Object.assign(c, p.clip);
    if (i > 0) c.transition = { ...p.transition };
  });
  for (const c of project.tracks.overlay) if (!c.locked) Object.assign(c, { filter: p.clip.filter, animIn: p.clip.animIn });
  engine.applyRatio(); fitPreview(); refresh(); pushHistory(); closeSheets();
  haptic([12, 30, 12]);
  toast(`Estilo «${p.nombre}» aplicado a todo el video`);
}
// Genera un clip de imagen de color sólido (para tarjetas, intros y outros).
async function makeColorClip(color, dur = 3, name = 'Color') {
  const cv = document.createElement('canvas');
  cv.width = project.width; cv.height = project.height;
  const cx = cv.getContext('2d'); cx.fillStyle = color; cx.fillRect(0, 0, cv.width, cv.height);
  const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
  const rec = await importFile(new File([blob], 'color.png', { type: 'image/png' }));
  if (rec.thumb) mediaThumbs.set(rec.id, rec.thumb);
  mediaNames.set(rec.id, name);
  const clip = createVideoClip({ mediaId: rec.id, type: 'image', duration: 0, width: rec.width, height: rec.height });
  clip.imageDuration = dur; clip.fillMode = 'cover';
  return clip;
}
async function addColorCard(color) {
  try {
    pushHistory();
    const clip = await makeColorClip(color, 3);
    project.tracks.video.push(clip);
    refresh(); pushHistory(); closeSheets(); timeline.select(clip.id, 'video');
    haptic(12); toast('Tarjeta de color añadida');
  } catch (e) { console.error(e); toast('No se pudo añadir la tarjeta'); }
}
// Plantilla de intro: tarjeta al principio + título centrado; desplaza las
// demás pistas para que todo empiece después de la intro.
async function addIntro() {
  try {
    const D = 2.5;
    pushHistory();
    const card = await makeColorClip('#000000', D, 'Intro');
    project.tracks.video.unshift(card);
    for (const c of project.tracks.overlay) c.start += D;
    for (const c of project.tracks.audio) c.start += D;
    for (const c of project.tracks.text) { c.start += D; c.end += D; }
    const t = createTextClip({ text: 'Tu título', start: 0, end: D });
    t.y = 0.5; t.size = 120; t.font = 'display'; t.bg = 'none'; t.stroke = true; t.animIn = 'pop'; t.animOut = 'fade';
    project.tracks.text.push(t);
    refresh(); pushHistory(); closeSheets(); engine.seek(0); timeline.setPlayhead(0);
    haptic(12); toast('Intro añadida — toca el título para editarlo');
  } catch (e) { console.error(e); toast('No se pudo añadir la intro'); }
}
// Plantilla de outro: tarjeta al final + texto de cierre centrado.
async function addOutro() {
  try {
    const D = 2.5;
    pushHistory();
    const card = await makeColorClip('#000000', D, 'Outro');
    project.tracks.video.push(card);
    const start = videoClipStart(project.tracks.video, project.tracks.video.length - 1);
    const t = createTextClip({ text: '¡Gracias por ver!', start, end: start + D });
    t.y = 0.5; t.size = 96; t.font = 'round'; t.bg = 'none'; t.stroke = true; t.animIn = 'fade'; t.animOut = 'fade';
    project.tracks.text.push(t);
    refresh(); pushHistory(); closeSheets();
    haptic(12); toast('Outro añadida — toca el texto para editarlo');
  } catch (e) { console.error(e); toast('No se pudo añadir la outro'); }
}

// Congela el fotograma actual: lo captura como imagen y lo inserta como clip fijo.
async function freezeFrame() {
  const clips = project.tracks.video;
  const at = videoClipAt(clips, engine.playhead);
  if (!at) { toast('Coloca el cursor sobre un video o foto para congelar'); return; }
  try {
    busy('Congelando fotograma…');
    const blob = await engine.captureBaseFrame();
    if (!blob) { busyDone(); toast('No se pudo capturar el fotograma'); return; }
    const file = new File([blob], 'congelado.png', { type: 'image/png' });
    pushHistory();
    const rec = await importFile(file);
    if (rec.thumb) mediaThumbs.set(rec.id, rec.thumb);
    mediaNames.set(rec.id, 'Congelado');
    const clip = createVideoClip({ mediaId: rec.id, type: 'image', duration: 0, width: rec.width, height: rec.height });
    clip.imageDuration = 2;
    clips.splice(at.index + 1, 0, clip);
    busyDone();
    refresh(); pushHistory(); timeline.select(clip.id, 'video');
    haptic(15); toast('🧊 Fotograma congelado (2s) añadido');
  } catch (e) { busyDone(); console.error(e); toast('No se pudo congelar: ' + (e.message || '')); }
}

function moveClip(sel, dir) {
  pushHistory();
  if (sel.track === 'video') {
    const clips = project.tracks.video;
    const i = clips.findIndex(c => c.id === sel.clip.id); const j = i + dir;
    if (j < 0 || j >= clips.length) return;
    [clips[i], clips[j]] = [clips[j], clips[i]];
  } else {
    // overlay / audio / text: desplaza en el tiempo.
    const step = 0.3 * dir;
    const c = sel.clip;
    const ns = Math.max(0, c.start + step);
    if (sel.track === 'text') { const len = c.end - c.start; c.start = ns; c.end = ns + len; }
    else c.start = ns;
  }
  refresh(); timeline.select(sel.clip.id, sel.track);
}

function duplicateClip(sel) {
  pushHistory();
  const copy = JSON.parse(JSON.stringify(sel.clip));
  copy.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const arr = project.tracks[sel.track];
  const i = arr.findIndex(c => c.id === sel.clip.id);
  if (sel.track === 'audio') copy.start += (copy.outPoint - copy.inPoint);
  else if (sel.track === 'text') { const d = copy.end - copy.start; copy.start += d; copy.end += d; }
  arr.splice(i + 1, 0, copy);
  refresh(); timeline.select(copy.id, sel.track); toast('Clip duplicado');
}

function deleteClip(sel) {
  pushHistory();
  const arr = project.tracks[sel.track];
  const i = arr.findIndex(c => c.id === sel.clip.id);
  if (i >= 0) arr.splice(i, 1);
  timeline.clearSelection(); onClipSelected(null); refresh(); haptic(25); toast('Clip borrado');
}

// ---------- Bloquear / desbloquear clip ----------
function toggleLock(sel) {
  pushHistory();
  sel.clip.locked = !sel.clip.locked;
  refresh(); timeline.select(sel.clip.id, sel.track);
  haptic(12); toast(sel.clip.locked ? '🔒 Clip bloqueado' : '🔓 Clip desbloqueado');
}

// ---------- Copiar / pegar clip ----------
let clipboard = null; // { track, clip }
function copyClip(sel) {
  clipboard = { track: sel.track, clip: JSON.parse(JSON.stringify(sel.clip)) };
  $('#btn-paste').hidden = false;
  haptic(10); toast('Copiado — usa «Pegar»');
}
function pasteClip() {
  if (!clipboard) { toast('Primero copia un clip'); return; }
  pushHistory();
  const track = clipboard.track;
  const clip = JSON.parse(JSON.stringify(clipboard.clip));
  clip.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const arr = project.tracks[track];
  if (track === 'video') {
    // inserta después del clip que está bajo el cursor (o al final).
    const at = videoClipAt(arr, engine.playhead);
    if (clip.type === 'video') { clip.transition = { type: 'none', duration: 0.6 }; }
    arr.splice(at ? at.index + 1 : arr.length, 0, clip);
    if (clip.mediaId) ensurePeaks(clip.mediaId);
  } else {
    // overlay / audio / text: empieza en el cursor.
    const t = engine.playhead;
    if (track === 'text') { const d = clip.end - clip.start; clip.start = t; clip.end = t + d; }
    else clip.start = t;
    if (track === 'audio' && clip.mediaId) ensurePeaks(clip.mediaId);
    arr.push(clip);
  }
  refresh(); timeline.select(clip.id, track); haptic(15); toast('Pegado en el cursor');
}

function onClipSelected(clip) {
  const has = !!clip;
  els.toolbarMain.hidden = has;
  els.clipTools.hidden = !has;
  if (has) {
    const lockBtn = $('#clip-tools [data-action="clip-lock"]');
    if (lockBtn) {
      setIcon(lockBtn, clip.locked ? 'unlock' : 'lock');
      lockBtn.querySelector('span').textContent = clip.locked ? 'Desbloq.' : 'Bloquear';
    }
    haptic(8);
  }
}

// ==================================================================
//  HOJAS
// ==================================================================
function openSheet(id) {
  els.backdrop.classList.add('show'); $('#' + id).classList.add('show');
  screens.editor.classList.add('sheet-open');
  engine.render(engine.playhead); // reajusta el fotograma al nuevo tamaño
}
function closeSheets() {
  els.backdrop.classList.remove('show');
  $$('.sheet').forEach(s => { s.classList.remove('show'); s.style.transform = ''; });
  screens.editor.classList.remove('sheet-open');
  fitPreview();
}

// Añade un botón ✕ (siempre visible) a cada hoja y cierra el teclado al tocar
// fuera de un campo de texto.
function injectSheetChrome() {
  $$('.sheet').forEach(sheet => {
    if (sheet.querySelector('.sheet-close')) return;
    const btn = document.createElement('button');
    btn.className = 'sheet-close';
    btn.setAttribute('data-close-sheet', '');
    btn.setAttribute('aria-label', 'Cerrar');
    btn.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#ic-close"/></svg>';
    sheet.appendChild(btn);
    const inner = sheet.querySelector('.sheet-inner');
    if (inner) inner.addEventListener('pointerdown', (e) => {
      const t = (e.target.tagName || '');
      if (t !== 'TEXTAREA' && t !== 'INPUT' && document.activeElement && document.activeElement.blur) {
        document.activeElement.blur();
      }
    });
  });
}

// Arrastrar hacia abajo el tirador de una hoja para cerrarla (móvil).
function bindSheetGestures() {
  $$('.sheet').forEach(sheet => {
    const handle = sheet.querySelector('.sheet-handle'); if (!handle) return;
    let startY = 0, dy = 0, dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (window.innerWidth >= 720) return; // solo layout móvil
      dragging = true; startY = e.clientY; dy = 0;
      sheet.style.transition = 'none';
      handle.setPointerCapture && handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      dy = Math.max(0, e.clientY - startY);
      sheet.style.transform = `translateY(${dy}px)`;
    });
    const end = () => {
      if (!dragging) return;
      dragging = false; sheet.style.transition = '';
      if (dy > 110) { closeSheets(); pushHistory(); } else sheet.style.transform = '';
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
}

// ---------- Editar (ajustes + transform + motion) ----------
let adjustTarget = null;
function labelFor(sel) { return $(sel).closest('label'); }
function showLabels(cls, show) { $$(`.${cls}`).forEach(l => l.style.display = show ? '' : 'none'); }

function openAdjustSheet(clip, track) {
  pushHistory();
  adjustTarget = { clip, track };
  const isImage = clip.type === 'image';
  const isVisual = track === 'video' || track === 'overlay';
  const hasVolume = track === 'audio' || (isVisual && clip.type === 'video');
  $('#adjust-title').textContent = track === 'audio' ? 'Audio' : track === 'overlay' ? 'Superposición (video encima)' : isImage ? 'Imagen' : 'Video';
  $('#adj-visual-block').style.display = isVisual ? '' : 'none';

  const set = (sel, v) => { $(sel).value = v; };
  set('#adj-volume', Math.round((clip.volume ?? 1) * 100));
  set('#adj-fadein', clip.fadeIn ?? 0);
  set('#adj-fadeout', clip.fadeOut ?? 0);
  set('#adj-duration', clip.imageDuration ?? 3);
  set('#adj-scale', Math.round((clip.scale ?? 1) * 100));
  set('#adj-rotate', clip.rotate ?? 0);
  set('#adj-brightness', Math.round((clip.brightness ?? 1) * 100));
  set('#adj-contrast', Math.round((clip.contrast ?? 1) * 100));
  set('#adj-saturation', Math.round((clip.saturation ?? 1) * 100));
  set('#adj-temp', clip.temp ?? 0);
  set('#adj-hue', clip.hue ?? 0);
  set('#adj-vignette', clip.vignette ?? 0);
  set('#adj-grain', clip.grain ?? 0);
  set('#adj-opacity', Math.round((clip.opacity ?? 1) * 100));

  labelFor('#adj-volume').style.display = hasVolume ? '' : 'none';
  showLabels('only-audio', track === 'audio');
  showLabels('only-image', isImage);
  showLabels('only-visual', isVisual);
  // La viñeta y el grano solo afectan al clip de fondo (no a la superposición).
  labelFor('#adj-vignette').style.display = track === 'video' ? '' : 'none';
  labelFor('#adj-grain').style.display = track === 'video' ? '' : 'none';

  set('#adj-animindur', clip.animInDur ?? 0.5);
  set('#adj-animoutdur', clip.animOutDur ?? 0.5);
  setActive('#filters-row', 'filter', clip.filter || 'none');
  setActive('#motion-row', 'motion', clip.motion || 'none');
  setActive('#anim-in-row', 'animin', clip.animIn || 'none');
  setActive('#anim-out-row', 'animout', clip.animOut || 'none');
  $('#flip-row [data-flip=h]').classList.toggle('active', !!clip.flipH);
  $('#flip-row [data-flip=v]').classList.toggle('active', !!clip.flipV);
  setActive('#fill-row', 'fill', clip.fillMode || 'contain');
  updateFillUI(clip);
  // Mezcla: solo para superposiciones.
  $$('.only-overlay').forEach(l => l.style.display = track === 'overlay' ? (l.classList.contains('opt-chips') ? 'flex' : (l.classList.contains('opt-grid') ? 'grid' : 'block')) : 'none');
  setActive('#blend-row', 'blend', clip.blend || 'normal');
  setActive('#border-row', 'border', clip.borderW > 0 ? (clip.borderColor || '#ffffff') : 'off');
  set('#adj-borderw', clip.borderW ? Math.round(clip.borderW * 100) : 0);
  $('#out-borderw').textContent = (clip.borderW ? Math.round(clip.borderW * 100) : 0) + '%';
  setActive('#mask-row', 'mask', clip.mask || 'none');
  updateKfUI(clip);
  updateAdjustOutputs();
  updateChromaUI();
  openSheet('sheet-adjust');
}

function updateChromaUI() {
  const c = adjustTarget && adjustTarget.clip;
  const on = !!(c && c.chroma && c.chroma.on);
  setActive('#chroma-row', 'chroma', on ? c.chroma.color : 'off');
  $('#adj-csim').value = Math.round((c?.chroma?.similarity ?? 0.4) * 100);
  $('#adj-csm').value = Math.round((c?.chroma?.smooth ?? 0.12) * 100);
  $('#out-csim').textContent = $('#adj-csim').value + '%';
  $('#out-csm').textContent = $('#adj-csm').value + '%';
  $$('.only-chroma').forEach(l => l.style.display = on ? 'block' : 'none');
}
function invalidateChroma(clip) { engine._chromaCache.delete(clip.id); }

function updateFillUI(clip) {
  const isColor = clip.bg && clip.bg !== 'blur' && clip.bg !== 'none';
  $$('#fill-row [data-bg]').forEach(b => b.classList.toggle('active', b.dataset.bg === 'blur' ? clip.bg === 'blur' : isColor));
  $('#fill-colors').style.display = isColor ? 'flex' : 'none';
  $$('#fill-colors .swatch').forEach(s => s.classList.toggle('active', s.dataset.color === clip.bg));
}

// ---------- Keyframes ----------
function clipLocalTime(clip, track) {
  if (track === 'overlay') return Math.max(0, Math.min(engine.playhead - clip.start, overlayDuration(clip)));
  const clips = project.tracks.video; const i = clips.indexOf(clip);
  const start = videoClipStart(clips, i);
  return Math.max(0, Math.min(engine.playhead - start, clipDuration(clip)));
}
function currentTransform(c) {
  return { scale: c.scale ?? 1, offsetX: c.offsetX ?? 0, offsetY: c.offsetY ?? 0, rotate: c.rotate ?? 0, opacity: c.opacity ?? 1 };
}
function upsertKeyframe(clip, track) {
  if (!clip.keyframes) clip.keyframes = [];
  const t = clipLocalTime(clip, track);
  const entry = { t, ...currentTransform(clip) };
  const idx = clip.keyframes.findIndex(k => Math.abs(k.t - t) < 0.05);
  if (idx >= 0) clip.keyframes[idx] = entry; else { clip.keyframes.push(entry); clip.keyframes.sort((a, b) => a.t - b.t); }
}
function updateKfUI(clip) {
  const n = (clip.keyframes || []).length;
  const btn = $('#kf-add-label'); if (btn) btn.textContent = n ? `Keyframe (${n})` : 'Añadir keyframe';
  $('#kf-add').classList.toggle('active', n > 0);
}

function updateAdjustOutputs() {
  $('#out-volume').textContent = $('#adj-volume').value + '%';
  $('#out-fadein').textContent = (+$('#adj-fadein').value).toFixed(1) + 's';
  $('#out-fadeout').textContent = (+$('#adj-fadeout').value).toFixed(1) + 's';
  $('#out-duration').textContent = (+$('#adj-duration').value).toFixed(1) + 's';
  $('#out-scale').textContent = $('#adj-scale').value + '%';
  $('#out-rotate').textContent = $('#adj-rotate').value + '°';
  $('#out-brightness').textContent = $('#adj-brightness').value + '%';
  $('#out-contrast').textContent = $('#adj-contrast').value + '%';
  $('#out-saturation').textContent = $('#adj-saturation').value + '%';
  $('#out-temp').textContent = $('#adj-temp').value;
  $('#out-hue').textContent = $('#adj-hue').value + '°';
  $('#out-vignette').textContent = $('#adj-vignette').value + '%';
  $('#out-grain').textContent = $('#adj-grain').value + '%';
  $('#out-opacity').textContent = $('#adj-opacity').value + '%';
  $('#out-animindur').textContent = (+$('#adj-animindur').value).toFixed(1) + 's';
  $('#out-animoutdur').textContent = (+$('#adj-animoutdur').value).toFixed(1) + 's';
}

function bindAdjust() {
  const apply = () => {
    if (!adjustTarget) return;
    const c = adjustTarget.clip;
    c.volume = (+$('#adj-volume').value) / 100;
    c.fadeIn = +$('#adj-fadein').value; c.fadeOut = +$('#adj-fadeout').value;
    if (c.type === 'image') c.imageDuration = +$('#adj-duration').value;
    c.scale = (+$('#adj-scale').value) / 100;
    c.rotate = +$('#adj-rotate').value;
    c.brightness = (+$('#adj-brightness').value) / 100;
    c.contrast = (+$('#adj-contrast').value) / 100;
    c.saturation = (+$('#adj-saturation').value) / 100;
    c.temp = +$('#adj-temp').value;
    c.hue = +$('#adj-hue').value;
    c.vignette = +$('#adj-vignette').value;
    c.grain = +$('#adj-grain').value;
    c.opacity = (+$('#adj-opacity').value) / 100;
    c.animInDur = +$('#adj-animindur').value;
    c.animOutDur = +$('#adj-animoutdur').value;
    c.borderW = (+$('#adj-borderw').value) / 100;
    $('#out-borderw').textContent = $('#adj-borderw').value + '%';
    if (adjustTarget.track === 'overlay') setActive('#border-row', 'border', c.borderW > 0 ? (c.borderColor || '#ffffff') : 'off');
    if (c.keyframes && c.keyframes.length) { upsertKeyframe(c, adjustTarget.track); updateKfUI(c); }
    updateAdjustOutputs();
    engine.applyGains(); engine.render(engine.playhead);
    timeline.requestRender(); updateDurationUI(); scheduleSave();
  };
  ['#adj-volume', '#adj-fadein', '#adj-fadeout', '#adj-duration', '#adj-scale', '#adj-rotate',
   '#adj-brightness', '#adj-contrast', '#adj-saturation', '#adj-temp', '#adj-hue', '#adj-vignette', '#adj-grain', '#adj-opacity',
   '#adj-animindur', '#adj-animoutdur', '#adj-borderw']
    .forEach(sel => $(sel).addEventListener('input', apply));

  $('#anim-in-row').addEventListener('click', (e) => {
    const b = e.target.closest('[data-animin]'); if (!b || !adjustTarget) return;
    adjustTarget.clip.animIn = b.dataset.animin; setActive('#anim-in-row', 'animin', b.dataset.animin);
    engine.render(engine.playhead); scheduleSave();
  });
  $('#anim-out-row').addEventListener('click', (e) => {
    const b = e.target.closest('[data-animout]'); if (!b || !adjustTarget) return;
    adjustTarget.clip.animOut = b.dataset.animout; setActive('#anim-out-row', 'animout', b.dataset.animout);
    engine.render(engine.playhead); scheduleSave();
  });

  $('#filters-row').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]'); if (!b || !adjustTarget) return;
    adjustTarget.clip.filter = b.dataset.filter; setActive('#filters-row', 'filter', b.dataset.filter);
    engine.render(engine.playhead); scheduleSave();
  });
  $('#motion-row').addEventListener('click', (e) => {
    const b = e.target.closest('[data-motion]'); if (!b || !adjustTarget) return;
    adjustTarget.clip.motion = b.dataset.motion; setActive('#motion-row', 'motion', b.dataset.motion);
    engine.render(engine.playhead); scheduleSave();
  });
  $('#flip-row').addEventListener('click', (e) => {
    const b = e.target.closest('[data-flip]'); if (!b || !adjustTarget) return;
    const c = adjustTarget.clip;
    if (b.dataset.flip === 'h') c.flipH = !c.flipH; else c.flipV = !c.flipV;
    b.classList.toggle('active', b.dataset.flip === 'h' ? !!c.flipH : !!c.flipV);
    engine.render(engine.playhead); scheduleSave();
  });
  $('#btn-apply-all-visual').addEventListener('click', () => {
    if (!adjustTarget) return;
    pushHistory();
    const s = adjustTarget.clip;
    const keys = ['filter', 'brightness', 'contrast', 'saturation', 'temp', 'hue', 'vignette', 'grain'];
    const targets = project.tracks[adjustTarget.track] || [];
    let n = 0;
    for (const c of targets) { if (c === s) continue; for (const k of keys) c[k] = s[k]; n++; }
    engine.render(engine.playhead); timeline.render(); scheduleSave();
    toast(n ? `Aplicado a ${n} clip${n > 1 ? 's' : ''} más` : 'No hay otros clips en la pista');
  });
  $('#btn-reset-transform').addEventListener('click', () => {
    if (!adjustTarget) return;
    pushHistory();
    const c = adjustTarget.clip;
    c.scale = 1; c.offsetX = 0; c.offsetY = 0; c.rotate = 0; c.flipH = false; c.flipV = false;
    if (c.keyframes) c.keyframes = [];
    $('#adj-scale').value = 100; $('#out-scale').textContent = '100%';
    $('#adj-rotate').value = 0; $('#out-rotate').textContent = '0°';
    $('#flip-row [data-flip=h]').classList.remove('active');
    $('#flip-row [data-flip=v]').classList.remove('active');
    updateKfUI(c);
    engine.render(engine.playhead); timeline.render(); scheduleSave();
    toast('Encuadre restablecido');
  });
  $('#blend-row').addEventListener('click', (e) => {
    const b = e.target.closest('[data-blend]'); if (!b || !adjustTarget) return;
    if (b.dataset.blend !== 'normal' && !requirePro('blend')) return;
    adjustTarget.clip.blend = b.dataset.blend; setActive('#blend-row', 'blend', b.dataset.blend);
    engine.render(engine.playhead); scheduleSave();
  });
  const PIP_POS = {
    tl: [-0.28, -0.32], tc: [0, -0.32], tr: [0.28, -0.32],
    ml: [-0.28, 0], c: [0, 0], mr: [0.28, 0],
    bl: [-0.28, 0.32], bc: [0, 0.32], br: [0.28, 0.32],
  };
  $('#pip-pos').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pos]'); if (!b || !adjustTarget) return;
    const p = PIP_POS[b.dataset.pos]; if (!p) return;
    pushHistory();
    adjustTarget.clip.offsetX = p[0]; adjustTarget.clip.offsetY = p[1];
    if (adjustTarget.clip.keyframes && adjustTarget.clip.keyframes.length) upsertKeyframe(adjustTarget.clip, adjustTarget.track);
    engine.render(engine.playhead); scheduleSave(); haptic(8);
  });
  $('#border-row').addEventListener('click', (e) => {
    const b = e.target.closest('[data-border]'); if (!b || !adjustTarget) return;
    const c = adjustTarget.clip;
    if (b.dataset.border === 'off') { c.borderW = 0; }
    else { c.borderColor = b.dataset.border; if (!c.borderW) c.borderW = 0.04; }
    setActive('#border-row', 'border', c.borderW > 0 ? c.borderColor : 'off');
    $('#adj-borderw').value = Math.round(c.borderW * 100); $('#out-borderw').textContent = Math.round(c.borderW * 100) + '%';
    engine.render(engine.playhead); scheduleSave();
  });
  $('#mask-row').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mask]'); if (!b || !adjustTarget) return;
    if (b.dataset.mask !== 'none' && !requirePro('mask')) return;
    adjustTarget.clip.mask = b.dataset.mask; setActive('#mask-row', 'mask', b.dataset.mask);
    engine.render(engine.playhead); timeline.render(); scheduleSave();
  });
  $('#kf-add').addEventListener('click', () => {
    if (!requirePro('keyframes')) return;
    if (!adjustTarget) return;
    upsertKeyframe(adjustTarget.clip, adjustTarget.track);
    updateKfUI(adjustTarget.clip); engine.render(engine.playhead); scheduleSave(); haptic(12);
    toast('Keyframe añadido. Mueve el cursor a otro momento y ajusta el clip.');
  });
  $('#kf-clear').addEventListener('click', () => {
    if (!adjustTarget) return;
    adjustTarget.clip.keyframes = [];
    updateKfUI(adjustTarget.clip); engine.render(engine.playhead); scheduleSave();
  });
  $('#fill-row').addEventListener('click', (e) => {
    const fillBtn = e.target.closest('[data-fill]');
    const bgBtn = e.target.closest('[data-bg]');
    if (!adjustTarget) return;
    const c = adjustTarget.clip;
    if (fillBtn) { c.fillMode = fillBtn.dataset.fill; setActive('#fill-row', 'fill', fillBtn.dataset.fill); }
    if (bgBtn) {
      if (bgBtn.dataset.bg === 'blur') c.bg = 'blur';
      else if (!c.bg || c.bg === 'blur') c.bg = '#101018';
      updateFillUI(c);
    }
    engine.render(engine.playhead); scheduleSave();
  });
  $('#fill-colors').addEventListener('click', (e) => {
    const s = e.target.closest('.swatch'); if (!s || !adjustTarget) return;
    adjustTarget.clip.bg = s.dataset.color;
    updateFillUI(adjustTarget.clip);
    engine.render(engine.playhead); scheduleSave();
  });

  // Chroma key
  $('#chroma-row').addEventListener('click', (e) => {
    { const b0 = e.target.closest('[data-chroma]'); if (b0 && b0.dataset.chroma !== 'off' && !requirePro('chroma')) return; }
    const b = e.target.closest('[data-chroma]'); if (!b || !adjustTarget) return;
    const v = b.dataset.chroma, c = adjustTarget.clip;
    if (v === 'pick') { startChromaPick(); return; }
    if (v === 'off') c.chroma.on = false;
    else { c.chroma.on = true; c.chroma.color = v; }
    invalidateChroma(c); updateChromaUI(); engine.render(engine.playhead); scheduleSave();
  });
  $('#adj-csim').addEventListener('input', () => {
    if (!adjustTarget) return;
    adjustTarget.clip.chroma.similarity = (+$('#adj-csim').value) / 100;
    $('#out-csim').textContent = $('#adj-csim').value + '%';
    invalidateChroma(adjustTarget.clip); engine.render(engine.playhead); scheduleSave();
  });
  $('#adj-csm').addEventListener('input', () => {
    if (!adjustTarget) return;
    adjustTarget.clip.chroma.smooth = (+$('#adj-csm').value) / 100;
    $('#out-csm').textContent = $('#adj-csm').value + '%';
    invalidateChroma(adjustTarget.clip); engine.render(engine.playhead); scheduleSave();
  });
}

// ---------- Cuentagotas de chroma ----------
let chromaPickMode = false;
function startChromaPick() {
  chromaPickMode = true;
  els.backdrop.style.pointerEvents = 'none';
  document.body.classList.add('picking');
}
function stopChromaPick() {
  chromaPickMode = false;
  els.backdrop.style.pointerEvents = '';
  document.body.classList.remove('picking');
}
function pickChromaColor(e) {
  const c = els.canvas, rect = c.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) / rect.width * c.width);
  const y = Math.floor((e.clientY - rect.top) / rect.height * c.height);
  let px;
  try { px = c.getContext('2d').getImageData(Math.max(0, Math.min(c.width - 1, x)), Math.max(0, Math.min(c.height - 1, y)), 1, 1).data; }
  catch { stopChromaPick(); return; }
  const hex = '#' + [px[0], px[1], px[2]].map(v => v.toString(16).padStart(2, '0')).join('');
  if (adjustTarget) {
    adjustTarget.clip.chroma.on = true;
    adjustTarget.clip.chroma.color = hex;
    invalidateChroma(adjustTarget.clip); updateChromaUI(); engine.render(engine.playhead); scheduleSave();
  }
  stopChromaPick(); haptic(12); toast('Color capturado: ' + hex);
}

// ---------- Audio / Volumen ----------
let audioTarget = null;
function openAudioSheet(clip) {
  pushHistory(); audioTarget = clip;
  $('#a-vol').value = Math.round((clip.volume ?? 1) * 100);
  $('#a-fi').value = clip.fadeIn ?? 0;
  $('#a-fo').value = clip.fadeOut ?? 0;
  updateAudioOutputs(); updateMuteBtn();
  openSheet('sheet-audio-clip');
}
function updateAudioOutputs() {
  $('#out-avol').textContent = $('#a-vol').value + '%';
  $('#out-afi').textContent = (+$('#a-fi').value).toFixed(1) + 's';
  $('#out-afo').textContent = (+$('#a-fo').value).toFixed(1) + 's';
}
function updateMuteBtn() {
  const m = audioTarget && audioTarget.muted;
  $('#mute-ico').textContent = m ? '🔇' : '🔊';
  $('#mute-label').textContent = m ? 'Activar sonido' : 'Silenciar';
  $('#btn-mute').classList.toggle('active', !!m);
}
function bindAudioClip() {
  const apply = () => {
    if (!audioTarget) return;
    audioTarget.volume = (+$('#a-vol').value) / 100;
    audioTarget.fadeIn = +$('#a-fi').value;
    audioTarget.fadeOut = +$('#a-fo').value;
    updateAudioOutputs();
    engine.applyGains(); engine.render(engine.playhead); scheduleSave();
  };
  ['#a-vol', '#a-fi', '#a-fo'].forEach(s => $(s).addEventListener('input', apply));
  $('#btn-mute').addEventListener('click', () => {
    if (!audioTarget) return;
    audioTarget.muted = !audioTarget.muted;
    updateMuteBtn(); engine.applyGains(); engine.render(engine.playhead); timeline.render(); scheduleSave(); haptic(10);
  });
  $('#btn-vol-all').addEventListener('click', () => {
    if (!audioTarget) return;
    pushHistory();
    const v = audioTarget.volume ?? 1;
    for (const c of [...project.tracks.video, ...project.tracks.overlay, ...project.tracks.audio]) c.volume = v;
    engine.applyGains(); engine.render(engine.playhead); timeline.render(); scheduleSave();
    toast('Volumen aplicado a todos los clips');
  });
  $('#btn-save-mp3').addEventListener('click', async () => {
    if (!audioTarget) return;
    const btn = $('#btn-save-mp3');
    try {
      btn.style.opacity = '.5'; toast('Convirtiendo a MP3…');
      const rec = await loadMediaRecord(audioTarget.mediaId);
      if (!rec) { toast('No hay medio que convertir'); return; }
      const mp3 = await mediaToMp3(rec.blob, () => {});
      const url = URL.createObjectURL(mp3);
      const a = document.createElement('a');
      a.href = url; a.download = (rec.name || 'audio').replace(/\.[^.]+$/, '') + '.mp3';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      haptic(15); toast('MP3 guardado en tu dispositivo');
    } catch (e) { console.error(e); toast('No se pudo convertir: ' + (e.message || '')); }
    finally { btn.style.opacity = ''; }
  });
}

// ---------- Velocidad ----------
let speedTarget = null;
function openSpeedSheet(clip) {
  pushHistory(); speedTarget = clip;
  $('#adj-speed').value = clip.speed || 1;
  $('#out-speed').textContent = (clip.speed || 1).toFixed(2) + '×';
  setActive('#speed-presets', 'speed', clip.speed || 1);
  openSheet('sheet-speed');
}
// Curvas de velocidad. Cada curva es una lista de tramos: qué porción del
// clip ocupa (fracción del original) y a qué velocidad va. Se aplican
// partiendo el clip en varios, así reutilizan el motor ya probado y salen
// idénticas en la vista previa y en la exportación.
const SPEED_CURVES = {
  montage:  { nombre: 'Montaje',        tramos: [[.25, .5], [.5, 2.4], [.25, .5]] },
  hero:     { nombre: 'Héroe',          tramos: [[.2, 2], [.25, .35], [.2, 2], [.35, 1]] },
  bullet:   { nombre: 'Bala',           tramos: [[.35, 3], [.3, .3], [.35, 3]] },
  flashin:  { nombre: 'Entrada rápida', tramos: [[.3, 3.5], [.7, 1]] },
  flashout: { nombre: 'Salida rápida',  tramos: [[.7, 1], [.3, 3.5]] },
  jump:     { nombre: 'Saltos',         tramos: [[.2, 2.5], [.2, .6], [.2, 2.5], [.2, .6], [.2, 2.5]] },
};
function applySpeedCurve(key) {
  const c = SPEED_CURVES[key];
  if (!c || !speedTarget) return;
  const clips = project.tracks.video;
  const idx = clips.indexOf(speedTarget);
  if (idx < 0) { toast('La curva solo se aplica a clips del video principal'); return; }
  if (speedTarget.type !== 'video') { toast('La curva de velocidad es para clips de video'); return; }
  const src = speedTarget.outPoint - speedTarget.inPoint;
  if (src < 0.6) { toast('El clip es muy corto para una curva de velocidad'); return; }

  pushHistory();
  const base = speedTarget;
  const inPoint = base.inPoint;
  const nuevos = [];
  let cursor = inPoint;
  c.tramos.forEach(([frac, spd], i) => {
    const seg = JSON.parse(JSON.stringify(base));
    seg.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + i;
    seg.inPoint = cursor;
    // El último tramo llega justo al final para no perder ni un fotograma.
    cursor = (i === c.tramos.length - 1) ? base.outPoint : Math.min(base.outPoint, cursor + src * frac);
    seg.outPoint = cursor;
    seg.speed = spd;
    // Solo el primer tramo conserva la transición de entrada del clip original.
    if (i > 0) seg.transition = { type: 'none', duration: 0.6 };
    seg.keyframes = [];
    nuevos.push(seg);
  });
  clips.splice(idx, 1, ...nuevos);
  refresh(); pushHistory(); closeSheets();
  timeline.select(nuevos[0].id, 'video');
  haptic([12, 30, 12]);
  toast(`Curva «${c.nombre}» aplicada en ${nuevos.length} tramos`);
}

function bindSpeed() {
  const apply = (v) => {
    if (!speedTarget) return;
    speedTarget.speed = Math.max(0.25, Math.min(4, v));
    $('#adj-speed').value = speedTarget.speed;
    $('#out-speed').textContent = speedTarget.speed.toFixed(2) + '×';
    setActive('#speed-presets', 'speed', speedTarget.speed);
    refresh();
  };
  $('#adj-speed').addEventListener('input', () => apply(+$('#adj-speed').value));
  $('#speed-presets').addEventListener('click', (e) => { const b = e.target.closest('[data-speed]'); if (b) apply(+b.dataset.speed); });
  $('#speed-curves').addEventListener('click', (e) => {
    const b = e.target.closest('[data-curve]'); if (!b) return;
    if (!requirePro('curves')) return;
    applySpeedCurve(b.dataset.curve);
  });
}

// ---------- Transición ----------
let transTarget = null;
function openTransitionForClip(clip) {
  const clips = project.tracks.video;
  const i = clips.findIndex(c => c.id === clip.id);
  if (i <= 0) { toast('Necesitas un clip anterior para poner transición'); return; }
  openTransitionSheet(clip);
}
function openTransitionSheet(clip) {
  pushHistory(); transTarget = clip;
  const tr = clip.transition || { type: 'none', duration: 0.6 };
  setActive('#transition-grid', 'trans', tr.type);
  $('#adj-transdur').value = tr.duration || 0.6;
  $('#out-transdur').textContent = (tr.duration || 0.6).toFixed(1) + 's';
  openSheet('sheet-transition');
}
function bindTransition() {
  $('#transition-grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-trans]'); if (!b || !transTarget) return;
    transTarget.transition.type = b.dataset.trans;
    setActive('#transition-grid', 'trans', b.dataset.trans);
    refresh();
  });
  $('#adj-transdur').addEventListener('input', () => {
    if (!transTarget) return;
    transTarget.transition.duration = +$('#adj-transdur').value;
    $('#out-transdur').textContent = (+$('#adj-transdur').value).toFixed(1) + 's';
    refresh();
  });
}

// ---------- Formato ----------
function openRatioSheet() {
  pushHistory();
  setActive('#ratio-grid', 'ratio', project.ratio);
  openSheet('sheet-ratio');
}
function bindRatio() {
  $('#ratio-grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ratio]'); if (!b) return;
    const r = b.dataset.ratio; const [w, h] = RATIOS[r];
    project.ratio = r; project.width = w; project.height = h;
    setActive('#ratio-grid', 'ratio', r);
    engine.applyRatio(); fitPreview(); refresh();
  });
  $('#btn-swap-orient').addEventListener('click', () => {
    pushHistory();
    const w = project.height, h = project.width; // intercambia ancho/alto
    project.width = w; project.height = h;
    // Busca una etiqueta de formato que coincida; si no, usa una a medida.
    let label = Object.keys(RATIOS).find(k => RATIOS[k][0] === w && RATIOS[k][1] === h);
    if (!label) { const parts = (project.ratio || '').split(':'); label = parts.length === 2 ? `${parts[1]}:${parts[0]}` : `${w}:${h}`; }
    project.ratio = label;
    setActive('#ratio-grid', 'ratio', label);
    engine.applyRatio(); fitPreview(); refresh();
    toast(w > h ? 'Lienzo horizontal' : 'Lienzo vertical');
  });
}

// ---------- Texto ----------
let textTarget = null;
function openTextSheet(clip) {
  pushHistory(); textTarget = clip;
  $('#text-title').textContent = clip.isSticker ? 'Sticker' : 'Texto';
  $('#text-content').value = clip.text || '';
  $('#text-font-label').style.display = clip.isSticker ? 'none' : '';
  $('#text-fonts').style.display = clip.isSticker ? 'none' : '';
  $('#text-bg-label').style.display = clip.isSticker ? 'none' : '';
  $('#text-bg').style.display = clip.isSticker ? 'none' : '';
  const set = (sel, v) => $(sel).value = v;
  set('#text-size', clip.size || 64); set('#text-y', Math.round((clip.y ?? 0.8) * 100));
  set('#text-x', Math.round((clip.x ?? 0.5) * 100)); set('#text-rot', clip.rotate || 0);
  $('#out-textsize').textContent = clip.size || 64;
  $('#out-texty').textContent = Math.round((clip.y ?? 0.8) * 100) + '%';
  $('#out-textx').textContent = Math.round((clip.x ?? 0.5) * 100) + '%';
  $('#out-textrot').textContent = (clip.rotate || 0) + '°';
  set('#text-ls', clip.letterSpacing || 0);
  $('#out-textls').textContent = clip.letterSpacing || 0;
  $$('#text-colors .swatch').forEach(s => s.classList.toggle('active', s.dataset.color === clip.color));
  setActive('#text-fonts', 'font', clip.font || 'sans');
  setActive('#text-bg', 'bg', clip.bg || 'none');
  setActive('#text-anim', 'anim', clip.animIn || 'none');
  const sh = $('#text-effects [data-toggle=shadow]'); if (sh) sh.classList.toggle('active', !!clip.shadow);
  const vt = $('#text-effects [data-toggle=vertical]'); if (vt) vt.classList.toggle('active', !!clip.vertical);
  openSheet('sheet-text');
}
function bindText() {
  const apply = () => {
    if (!textTarget) return;
    textTarget.text = $('#text-content').value || ' ';
    textTarget.size = +$('#text-size').value;
    textTarget.y = (+$('#text-y').value) / 100;
    textTarget.x = (+$('#text-x').value) / 100;
    textTarget.rotate = +$('#text-rot').value;
    textTarget.letterSpacing = +$('#text-ls').value;
    $('#out-textsize').textContent = textTarget.size;
    $('#out-texty').textContent = $('#text-y').value + '%';
    $('#out-textx').textContent = $('#text-x').value + '%';
    $('#out-textrot').textContent = $('#text-rot').value + '°';
    $('#out-textls').textContent = $('#text-ls').value;
    engine.render(engine.playhead); timeline.requestRender(); scheduleSave();
  };
  ['#text-content', '#text-size', '#text-y', '#text-x', '#text-rot', '#text-ls'].forEach(s => $(s).addEventListener('input', apply));
  const fx = $('#text-effects');
  if (fx) fx.addEventListener('click', (e) => {
    const b = e.target.closest('[data-toggle]'); if (!b || !textTarget) return;
    if (b.dataset.toggle === 'shadow') { textTarget.shadow = !textTarget.shadow; b.classList.toggle('active', !!textTarget.shadow); }
    else if (b.dataset.toggle === 'vertical') { textTarget.vertical = !textTarget.vertical; b.classList.toggle('active', !!textTarget.vertical); }
    engine.render(engine.playhead); scheduleSave();
  });
  $('#text-colors').addEventListener('click', (e) => {
    const sw = e.target.closest('.swatch'); if (!sw || !textTarget) return;
    textTarget.color = sw.dataset.color;
    $$('#text-colors .swatch').forEach(s => s.classList.toggle('active', s === sw));
    engine.render(engine.playhead); scheduleSave();
  });
  $('#text-fonts').addEventListener('click', (e) => { const b = e.target.closest('[data-font]'); if (!b || !textTarget) return; textTarget.font = b.dataset.font; setActive('#text-fonts', 'font', b.dataset.font); engine.render(engine.playhead); scheduleSave(); });
  $('#text-bg').addEventListener('click', (e) => { const b = e.target.closest('[data-bg]'); if (!b || !textTarget) return; textTarget.bg = b.dataset.bg; setActive('#text-bg', 'bg', b.dataset.bg); engine.render(engine.playhead); scheduleSave(); });
  $('#text-anim').addEventListener('click', (e) => { const b = e.target.closest('[data-anim]'); if (!b || !textTarget) return; textTarget.animIn = b.dataset.anim; textTarget.animOut = b.dataset.anim; setActive('#text-anim', 'anim', b.dataset.anim); engine.render(engine.playhead); scheduleSave(); });
  $('#text-presets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]'); if (!b || !textTarget) return;
    const t = textTarget;
    if (b.dataset.preset === 'subtitle') { t.y = 0.86; t.size = 52; t.font = 'sans'; t.bold = true; t.bg = 'black'; t.stroke = false; t.animIn = 'fade'; t.animOut = 'fade'; }
    else if (b.dataset.preset === 'title') { t.y = 0.5; t.size = 128; t.font = 'display'; t.bg = 'none'; t.stroke = true; t.animIn = 'pop'; t.animOut = 'none'; }
    else if (b.dataset.preset === 'caption') { t.y = 0.2; t.size = 72; t.font = 'round'; t.bg = 'color'; t.stroke = false; t.animIn = 'slideup'; t.animOut = 'fade'; }
    else if (b.dataset.preset === 'neon') { t.y = 0.5; t.size = 104; t.font = 'display'; t.color = '#00e5ff'; t.bg = 'none'; t.stroke = true; t.shadow = true; t.letterSpacing = 2; t.animIn = 'pop'; t.animOut = 'fade'; }
    else if (b.dataset.preset === 'meme') { t.y = 0.14; t.size = 96; t.font = 'display'; t.color = '#ffffff'; t.bg = 'none'; t.stroke = true; t.shadow = false; t.letterSpacing = 0; t.animIn = 'none'; t.animOut = 'none'; }
    else if (b.dataset.preset === 'glow') { t.y = 0.5; t.size = 88; t.font = 'round'; t.color = '#ffffff'; t.bg = 'none'; t.stroke = false; t.shadow = true; t.letterSpacing = 4; t.animIn = 'fade'; t.animOut = 'fade'; }
    else if (b.dataset.preset === 'retro') { t.y = 0.8; t.size = 76; t.font = 'classic'; t.color = '#ffd23b'; t.bg = 'color'; t.bgColor = '#7c3aed'; t.stroke = false; t.shadow = false; t.letterSpacing = 3; t.animIn = 'slidedown'; t.animOut = 'fade'; }
    openTextSheet(t); // refresca controles
    engine.render(engine.playhead); timeline.render(); scheduleSave();
  });
  $('#text-delete').addEventListener('click', () => {
    if (!textTarget) return;
    const i = project.tracks.text.findIndex(c => c.id === textTarget.id);
    if (i >= 0) project.tracks.text.splice(i, 1);
    textTarget = null; timeline.clearSelection(); onClipSelected(null); closeSheets(); refresh();
  });
}

// ==================================================================
//  EXPORTAR
// ==================================================================
let exportRes = perf.suggestedExportTier(), exportFps = 30;

// ---------- Ajustes / Rendimiento ----------
function defaultImageDur() { return +(localStorage.getItem('playcut.imgDur') || 3) || 3; }
function openSettings() {
  $('#device-info').textContent = perf.deviceSummary();
  setActive('#perf-grid', 'perf', perf.getMode());
  $$('#bg-colors .swatch').forEach(s => s.classList.toggle('active', s.dataset.color === project.bgColor));
  $('#set-imgdur').value = defaultImageDur();
  $('#out-imgdur').textContent = defaultImageDur().toFixed(1) + 's';
  $('#set-projfadein').value = project.fadeIn || 0;
  $('#out-projfadein').textContent = (project.fadeIn || 0).toFixed(1) + 's';
  $('#set-projfadeout').value = project.fadeOut || 0;
  $('#out-projfadeout').textContent = (project.fadeOut || 0).toFixed(1) + 's';
  openSheet('sheet-settings');
}
function bindSettings() {
  $('#perf-grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-perf]'); if (!b) return;
    perf.setMode(b.dataset.perf); setActive('#perf-grid', 'perf', b.dataset.perf);
    engine.applyPerf(); $('#device-info').textContent = perf.deviceSummary();
    toast('Rendimiento: ' + b.textContent.trim());
  });
  $('#bg-colors').addEventListener('click', (e) => {
    const s = e.target.closest('.swatch'); if (!s) return;
    pushHistory(); project.bgColor = s.dataset.color;
    $$('#bg-colors .swatch').forEach(x => x.classList.toggle('active', x === s));
    engine.render(engine.playhead); scheduleSave();
  });
  $('#set-imgdur').addEventListener('input', () => {
    const v = +$('#set-imgdur').value;
    localStorage.setItem('playcut.imgDur', v);
    $('#out-imgdur').textContent = v.toFixed(1) + 's';
  });
  $('#set-projfadein').addEventListener('input', () => {
    project.fadeIn = +$('#set-projfadein').value;
    $('#out-projfadein').textContent = project.fadeIn.toFixed(1) + 's';
    engine.render(engine.playhead); scheduleSave();
  });
  $('#set-projfadeout').addEventListener('input', () => {
    project.fadeOut = +$('#set-projfadeout').value;
    $('#out-projfadeout').textContent = project.fadeOut.toFixed(1) + 's';
    engine.render(engine.playhead); scheduleSave();
  });
}

// ---------- Zoom de la línea de tiempo ----------
function zoomBy(f) { timeline.setZoom(timeline._zoom * f, engine.playhead); }

// ---------- Atajos de teclado (escritorio) ----------
function nudgePlayhead(d) {
  engine.pause(); setPlayIcon(false);
  const t = Math.max(0, Math.min(engine.playhead + d, projectDuration(project)));
  engine.seek(t); timeline.setPlayhead(t); updateTimeUI(t);
}
function onKey(e) {
  if (!screens.editor.classList.contains('active')) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); nudgePlayhead(e.shiftKey ? -1 : -0.1); break;
    case 'ArrowRight': e.preventDefault(); nudgePlayhead(e.shiftKey ? 1 : 0.1); break;
    case 's': case 'S': splitAtPlayhead(); break;
    case '+': case '=': zoomBy(1.4); break;
    case '-': case '_': zoomBy(1 / 1.4); break;
    case 'Delete': case 'Backspace': { const sel = getSelectedClip(); if (sel) deleteClip(sel); break; }
  }
}
function updateExportMeta() {
  const { w, h } = computeExportSize(project, exportRes);
  $('#export-meta').textContent = `${w} × ${h} · ${exportFps} fps`;
}
function bindExport() {
  els.btnExport.addEventListener('click', () => {
    if (projectDuration(project) <= 0) { toast('El proyecto está vacío'); return; }
    exportFps = project.fps || 30;
    setActive('#export-res', 'res', exportRes);
    setActive('#export-fps', 'fps', exportFps);
    updateExportMeta();
    $('#export-config').hidden = false; $('#export-progress').hidden = true; $('#export-done').hidden = true;
    openSheet('sheet-export');
  });
  $('#export-res').addEventListener('click', (e) => { const b = e.target.closest('[data-res]'); if (!b) return; if (+b.dataset.res >= 2160 && !requirePro('4k')) return;
    exportRes = +b.dataset.res; setActive('#export-res', 'res', exportRes); updateExportMeta(); });
  $('#export-fps').addEventListener('click', (e) => { const b = e.target.closest('[data-fps]'); if (!b) return; exportFps = +b.dataset.fps; setActive('#export-fps', 'fps', exportFps); updateExportMeta(); });

  $('#btn-start-export').addEventListener('click', async () => {
    $('#export-config').hidden = true; $('#export-progress').hidden = false;
    setPlayIcon(false);
    try {
      const { blob, ext, w, h, fps } = await exportProject(engine, {
        tier: exportRes, fps: exportFps,
        onProgress: (p) => { $('#export-percent').textContent = p + '%'; $('#export-bar').style.width = p + '%'; },
      });
      const url = URL.createObjectURL(blob);
      $('#export-preview').hidden = false; $('#export-gif-preview').hidden = true;
      $('#export-preview').src = url;
      const link = $('#export-download');
      link.href = url; link.download = `${sanitize(project.name)}_${h}p.${ext}`;
      lastExportBlob = blob; lastExportName = `${sanitize(project.name)}_${h}p.${ext}`;
      $('#export-progress').hidden = true; $('#export-done').hidden = false;
      // Si el archivo es demasiado pequeño para su duración, el equipo no pudo
      // codificar esa resolución en tiempo real: avisa y sugiere bajar calidad.
      if (blob.size < 60000 && projectDuration(project) > 1.2 && exportRes >= 1440) {
        toast('Tu dispositivo no pudo procesar esa resolución. Prueba con una menor.');
      } else {
        toast(`Exportado ${w}×${h} · ${fps}fps`);
      }
    } catch (e) { console.error(e); toast('Error al exportar: ' + (e.message || e)); closeSheets(); }
  });

  // Compartir el vídeo exportado directamente (WhatsApp, Fotos, etc.)
  const shareBtn = $('#export-share');
  if (shareBtn) {
    const canShareFiles = !!(navigator.canShare && navigator.share);
    shareBtn.hidden = !canShareFiles;
    shareBtn.addEventListener('click', async () => {
      if (!lastExportBlob) return;
      const file = new File([lastExportBlob], lastExportName || 'playcut.mp4', { type: lastExportBlob.type || 'video/mp4' });
      try {
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: project.name || 'PlayCUT' });
        } else {
          toast('Tu dispositivo no permite compartir el archivo directamente. Usa Descargar.');
        }
      } catch (e) { if (e && e.name !== 'AbortError') toast('No se pudo compartir'); }
    });
  }

  const gifBtn = $('#btn-export-gif');
  if (gifBtn) gifBtn.addEventListener('click', exportGif);
}
let lastExportBlob = null, lastExportName = '';

// Exporta el proyecto como GIF animado capturando fotogramas en reproducción.
async function exportGif() {
  if (projectDuration(project) <= 0) { toast('El proyecto está vacío'); return; }
  const total = Math.min(projectDuration(project), 12); // límite práctico para GIF
  const long = Math.max(project.width, project.height);
  const scale = Math.min(1, 320 / long);
  const gw = Math.max(2, Math.round(project.width * scale / 2) * 2);
  const gh = Math.max(2, Math.round(project.height * scale / 2) * 2);
  const gifFps = 10;
  const off = document.createElement('canvas'); off.width = gw; off.height = gh;
  const octx = off.getContext('2d', { willReadFrequently: true });
  const frames = [];
  let lastCap = -1;

  $('#export-config').hidden = true; $('#export-progress').hidden = false; $('#export-done').hidden = true;
  $('#export-percent').textContent = '0%'; $('#export-bar').style.width = '0%';
  setPlayIcon(false);

  const prevTick = engine.onTick;
  engine._exporting = true;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; engine._exporting = false; engine.onTick = prevTick; engine.pause(); resolve(); };
    engine.onTick = (t, ended) => {
      if (lastCap < 0 || t - lastCap >= (1 / gifFps) - 1e-3) {
        lastCap = t;
        octx.drawImage(els.canvas, 0, 0, gw, gh);
        frames.push(octx.getImageData(0, 0, gw, gh).data.slice(0));
        const p = Math.min(99, Math.round(t / total * 100));
        $('#export-percent').textContent = p + '%'; $('#export-bar').style.width = p + '%';
      }
      if (ended || t >= total - 1e-2 || frames.length >= 130) finish();
    };
    engine.seek(0);
    engine.play();
    setTimeout(finish, total * 1000 + 5000); // seguridad
  });

  if (!frames.length) { toast('No se pudo capturar el GIF'); closeSheets(); return; }
  try {
    const blob = encodeGif(frames, gw, gh, Math.round(100 / gifFps));
    const url = URL.createObjectURL(blob);
    lastExportBlob = blob; lastExportName = `${sanitize(project.name)}.gif`;
    $('#export-preview').hidden = true;
    const gp = $('#export-gif-preview'); gp.hidden = false; gp.src = url;
    const link = $('#export-download'); link.href = url; link.download = lastExportName;
    const shareBtn = $('#export-share'); if (shareBtn) shareBtn.hidden = !(navigator.canShare && navigator.share);
    $('#export-progress').hidden = true; $('#export-done').hidden = false;
    toast(`GIF ${gw}×${gh} · ${frames.length} fotogramas`);
  } catch (e) { console.error(e); toast('No se pudo crear el GIF: ' + (e.message || '')); closeSheets(); }
}
function sanitize(name) { return String(name).replace(/[^\w\-]+/g, '_').slice(0, 40) || 'playcut'; }

// ==================================================================
//  GIFs (de internet, junto a los stickers)
// ==================================================================
function openGifSheet() {
  $('#gif-key').value = localStorage.getItem('playcut.giphyKey') || '';
  openSheet('sheet-gif');
  if (localStorage.getItem('playcut.giphyKey')) gifSearch('');
  else $('#gif-results').innerHTML = '<p class="export-meta">Pega un enlace de GIF arriba, o pon tu clave de GIPHY para buscar aquí.</p>';
}
let gifTimer = null;
function bindGif() {
  $('#gif-add-url').addEventListener('click', () => addGifFromUrl($('#gif-url').value.trim()));
  $('#gif-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') addGifFromUrl($('#gif-url').value.trim()); });
  $('#gif-key').addEventListener('input', () => {
    const k = $('#gif-key').value.trim();
    if (k) localStorage.setItem('playcut.giphyKey', k); else localStorage.removeItem('playcut.giphyKey');
  });
  $('#gif-search').addEventListener('input', () => {
    clearTimeout(gifTimer);
    gifTimer = setTimeout(() => gifSearch($('#gif-search').value.trim()), 350);
  });
}
async function gifSearch(q) {
  const box = $('#gif-results');
  const key = (localStorage.getItem('playcut.giphyKey') || '').trim();
  if (!key) { box.innerHTML = '<p class="export-meta">Para buscar necesitas una clave gratis de GIPHY (developers.giphy.com). Mientras, pega el enlace de un GIF arriba.</p>'; return; }
  box.innerHTML = '<p class="export-meta">Buscando…</p>';
  try {
    const url = q
      ? `https://api.giphy.com/v1/gifs/search?q=${encodeURIComponent(q)}&limit=24&rating=pg&api_key=${key}`
      : `https://api.giphy.com/v1/gifs/trending?limit=24&rating=pg&api_key=${key}`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.meta && j.meta.status >= 400) { box.innerHTML = '<p class="export-meta">Clave no válida. Revisa tu clave de GIPHY.</p>'; return; }
    box.innerHTML = '';
    if (!j.data || !j.data.length) { box.innerHTML = '<p class="export-meta">Sin resultados</p>'; return; }
    for (const g of j.data) {
      const img = document.createElement('img');
      img.className = 'gif-item'; img.loading = 'lazy';
      img.src = (g.images.fixed_width_small || g.images.fixed_width).url;
      const full = (g.images.fixed_width || g.images.downsized).url;
      img.addEventListener('click', () => addGifFromUrl(full, g.title));
      box.appendChild(img);
    }
  } catch (e) {
    console.error(e);
    box.innerHTML = '<p class="export-meta">No se pudo buscar. Revisa tu conexión o pega un enlace de GIF arriba.</p>';
  }
}
async function addGifFromUrl(url, title) {
  if (!url || !/^https?:\/\//i.test(url)) { toast('Pega un enlace válido (que empiece por http)'); return; }
  try {
    toast('Añadiendo GIF…');
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    if (!/gif|image/.test(blob.type)) throw new Error('El enlace no es una imagen/GIF');
    const file = new File([blob], (sanitize(title || 'gif')) + '.gif', { type: blob.type.includes('gif') ? 'image/gif' : (blob.type || 'image/gif') });
    pushHistory();
    const rec = await importFile(file);
    if (rec.thumb) mediaThumbs.set(rec.id, rec.thumb);
    mediaNames.set(rec.id, rec.name);
    const clip = createOverlayClip({ mediaId: rec.id, type: 'image', duration: 0, width: rec.width, height: rec.height, start: engine.playhead });
    clip.scale = 0.5; clip.offsetX = 0; clip.offsetY = 0; clip.bg = 'none'; clip.shadow = false; clip.radius = 0;
    project.tracks.overlay.push(clip);
    $('#gif-url').value = '';
    refresh(); pushHistory(); closeSheets();
    timeline.select(clip.id, 'overlay');
    haptic(12); toast('GIF añadido — arrástralo y cámbialo de tamaño con 2 dedos');
  } catch (e) { console.error(e); toast('No se pudo añadir el GIF: ' + (e.message || '')); }
}

// ==================================================================
//  VOZ EN OFF (grabar con el micrófono)
// ==================================================================
let voiceRec = null, voiceStream = null, voiceStart = 0, voiceChunks = [], voiceTimerId = null, voiceRecMs = 0;
function openVoiceSheet() {
  $('#voice-timer').textContent = '0:00';
  $('#voice-btn').textContent = '● Grabar'; $('#voice-btn').classList.remove('voice-btn-rec');
  openSheet('sheet-voice');
}
function bindVoice() { $('#voice-btn').addEventListener('click', toggleVoice); }
async function toggleVoice() {
  if (voiceRec && voiceRec.state === 'recording') { stopVoice(); return; }
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) { toast('No se pudo usar el micrófono. Da permiso e inténtalo otra vez.'); return; }
  const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
    : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
  try { voiceRec = new MediaRecorder(voiceStream, mime ? { mimeType: mime } : undefined); }
  catch { voiceRec = new MediaRecorder(voiceStream); }
  voiceChunks = [];
  voiceRec.ondataavailable = (e) => { if (e.data && e.data.size) voiceChunks.push(e.data); };
  voiceRec.onstop = onVoiceStop;
  voiceStart = engine.playhead; voiceRecMs = Date.now();
  voiceRec.start();
  if (projectDuration(project) > 0) { engine.play(); setPlayIcon(true); }
  $('#voice-btn').textContent = '■ Detener'; $('#voice-btn').classList.add('voice-btn-rec');
  clearInterval(voiceTimerId);
  voiceTimerId = setInterval(() => { $('#voice-timer').textContent = formatTime((Date.now() - voiceRecMs) / 1000).slice(0, 4); }, 200);
  haptic(15);
}
function stopVoice() {
  clearInterval(voiceTimerId);
  if (voiceRec && voiceRec.state !== 'inactive') voiceRec.stop();
  engine.pause(); setPlayIcon(false);
}
async function onVoiceStop() {
  if (voiceStream) { voiceStream.getTracks().forEach(t => t.stop()); voiceStream = null; }
  const secs = (Date.now() - voiceRecMs) / 1000;
  const blob = new Blob(voiceChunks, { type: (voiceRec && voiceRec.mimeType) || 'audio/webm' });
  $('#voice-btn').textContent = '● Grabar'; $('#voice-btn').classList.remove('voice-btn-rec');
  if (!blob.size) { toast('No se grabó audio'); return; }
  try {
    pushHistory();
    const ext = blob.type.includes('mp4') ? 'm4a' : 'webm';
    const rec = await importFile(new File([blob], 'voz.' + ext, { type: blob.type }));
    mediaNames.set(rec.id, 'Voz en off');
    const dur = (isFinite(rec.duration) && rec.duration > 0.1 && rec.duration < 86400) ? rec.duration : Math.max(0.3, secs);
    project.tracks.audio.push(createAudioClip({ mediaId: rec.id, duration: dur, start: voiceStart, name: 'Voz en off' }));
    ensurePeaks(rec.id);
    refresh(); pushHistory(); closeSheets();
    toast('🎙️ Voz en off añadida');
  } catch (e) { console.error(e); toast('No se pudo guardar la voz'); }
}

// ==================================================================
//  GESTOS EN LA VISTA PREVIA (pellizcar / arrastrar el clip)
// ==================================================================
function gestureTarget() {
  const sel = getSelectedClip();
  if (sel && ['video', 'overlay', 'text'].includes(sel.track)) return sel;
  const at = videoClipAt(project.tracks.video, engine.playhead);
  return at ? { clip: at.clip, track: 'video' } : null;
}
// Dibuja las guías de alineación (centro) sobre el lienzo mientras se arrastra.
function drawGuides(v, h) {
  const cv = els.canvas, ctx = cv.getContext('2d');
  ctx.save();
  ctx.strokeStyle = 'rgba(124,58,237,.95)';
  ctx.lineWidth = Math.max(1.5, cv.width * 0.004);
  ctx.setLineDash([cv.width * 0.02, cv.width * 0.02]);
  if (v) { ctx.beginPath(); ctx.moveTo(cv.width / 2, 0); ctx.lineTo(cv.width / 2, cv.height); ctx.stroke(); }
  if (h) { ctx.beginPath(); ctx.moveTo(0, cv.height / 2); ctx.lineTo(cv.width, cv.height / 2); ctx.stroke(); }
  ctx.restore();
}
function bindPreviewGestures() {
  const wrap = $('.preview-wrap');
  const canvas = els.canvas;
  const pointers = new Map();
  let g = null;
  wrap.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (chromaPickMode) return;
    if (pointers.size === 1) {
      let t = gestureTarget();
      if (t && t.clip.locked) t = null; // clip bloqueado: no se transforma
      g = { mode: 'maybe', t, sx: e.clientX, sy: e.clientY, moved: false,
        oScale: t ? (t.clip.scale ?? 1) : 1, oSize: t ? (t.clip.size ?? 64) : 64,
        oX: t ? (t.track === 'text' ? (t.clip.x ?? 0.5) : (t.clip.offsetX ?? 0)) : 0,
        oY: t ? (t.track === 'text' ? (t.clip.y ?? 0.8) : (t.clip.offsetY ?? 0)) : 0 };
    } else if (pointers.size === 2) {
      const t = gestureTarget();
      if (t && !t.clip.locked) {
        const p = [...pointers.values()];
        g = { mode: 'pinch', t, startDist: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), oScale: t.clip.scale ?? 1, oSize: t.clip.size ?? 64 };
        pushHistory();
      }
    }
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId) || !g) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const rect = canvas.getBoundingClientRect();
    if (g.mode === 'pinch' && pointers.size >= 2) {
      const p = [...pointers.values()];
      const ratio = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) / (g.startDist || 1);
      if (g.t.track === 'text') g.t.clip.size = Math.max(12, Math.min(400, g.oSize * ratio));
      else g.t.clip.scale = Math.max(0.1, Math.min(6, g.oScale * ratio));
      engine.render(engine.playhead);
    } else if (g.mode === 'maybe' || g.mode === 'drag') {
      const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
      if (!g.moved && Math.hypot(dx, dy) > 6) { g.moved = true; g.mode = 'drag'; if (g.t) pushHistory(); }
      if (g.mode === 'drag' && g.t) {
        const fx = dx / rect.width, fy = dy / rect.height;
        const SNAP = 0.02; // imán al centro (2% del lado)
        let snapV = false, snapH = false;
        if (g.t.track === 'text') {
          let nx = g.oX + fx, ny = g.oY + fy;
          if (Math.abs(nx - 0.5) < SNAP) { nx = 0.5; snapV = true; }
          if (Math.abs(ny - 0.5) < SNAP) { ny = 0.5; snapH = true; }
          g.t.clip.x = Math.max(0, Math.min(1, nx)); g.t.clip.y = Math.max(0, Math.min(1, ny));
        } else {
          let nx = g.oX + fx, ny = g.oY + fy;
          if (Math.abs(nx) < SNAP) { nx = 0; snapV = true; }
          if (Math.abs(ny) < SNAP) { ny = 0; snapH = true; }
          g.t.clip.offsetX = nx; g.t.clip.offsetY = ny;
        }
        engine.render(engine.playhead);
        if (snapV || snapH) { drawGuides(snapV, snapH); if (!g.snapped) { haptic(8); g.snapped = true; } }
        else g.snapped = false;
      }
    }
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (chromaPickMode) { pickChromaColor(e); if (pointers.size === 0) g = null; return; }
    if (!g) return;
    if ((g.mode === 'pinch' || g.mode === 'drag')) {
      // Si el clip tiene keyframes, la nueva transformación crea/actualiza uno.
      if (g.t && (g.t.track === 'video' || g.t.track === 'overlay') && g.t.clip.keyframes && g.t.clip.keyframes.length) {
        upsertKeyframe(g.t.clip, g.t.track);
      }
      engine.render(engine.playhead); // redibuja sin las guías
      scheduleSave(); timeline.render(); pushHistory();
      if (pointers.size === 0) g = null;
    } else if (g.mode === 'maybe' && !g.moved && pointers.size === 0) {
      // Toque simple: importar (si vacío) o reproducir.
      if (project.tracks.video.length === 0 && project.tracks.overlay.length === 0) els.fileMedia.click();
      else togglePlay();
      g = null;
    } else if (pointers.size === 0) g = null;
  };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);
}

// ==================================================================
//  EVENTOS GLOBALES
// ==================================================================
function bindGlobal() {
  els.btnNew.addEventListener('click', newProject);
  els.btnBack.addEventListener('click', () => { engine.pause(); setPlayIcon(false); scheduleSave(); showScreen('home'); renderProjects(); });
  els.btnUndo.addEventListener('click', undo);
  els.btnRedo.addEventListener('click', redo);
  els.btnRatio.addEventListener('click', openRatioSheet);
  els.projectName.addEventListener('input', () => { project.name = els.projectName.value; scheduleSave(); });
  els.btnPlay.addEventListener('click', togglePlay);

  els.seek.addEventListener('input', () => {
    engine.pause(); setPlayIcon(false);
    const t = (els.seek.value / 1000) * projectDuration(project);
    engine.seek(t); timeline.setPlayhead(t); updateTimeUI(t);
  });

  els.fileMedia.addEventListener('change', (e) => { handleMediaFiles([...e.target.files]); e.target.value = ''; });
  els.fileOverlay.addEventListener('change', (e) => { handleOverlayFiles([...e.target.files]); e.target.value = ''; });
  els.fileAudio.addEventListener('change', (e) => { handleAudioFiles([...e.target.files]); e.target.value = ''; });
  els.btnSettings.addEventListener('click', openSettings);
  els.btnZoomIn.addEventListener('click', () => zoomBy(1.4));
  els.btnZoomOut.addEventListener('click', () => zoomBy(1 / 1.4));
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', () => { if (project) { fitPreview(); timeline.render(); timeline.setPlayhead(engine.playhead); } });
  window.addEventListener('orientationchange', () => { setTimeout(() => { if (project) { fitPreview(); timeline.render(); timeline.setPlayhead(engine.playhead); } }, 250); });

  $('#timeline-scroll').addEventListener('click', (e) => {
    if (e.target.classList.contains('track') || e.target.classList.contains('timeline')) { timeline.clearSelection(); }
  });

  // La vista previa se maneja con gestos (bindPreviewGestures): toque para
  // reproducir/importar, arrastrar para mover, 2 dedos para escalar.

  els.backdrop.addEventListener('click', () => { closeSheets(); pushHistory(); });
  $$('[data-close-sheet]').forEach(b => b.addEventListener('click', () => { closeSheets(); pushHistory(); }));
  bindSheetGestures();

  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; els.btnInstall.hidden = false; });
  els.btnInstall.addEventListener('click', async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; els.btnInstall.hidden = true; });
}

// ==================================================================
//  INIT
// ==================================================================
function initTimeline() {
  timeline = new Timeline({
    root: $('#timeline'), scroll: $('#timeline-scroll'),
    trackEls: { video: $('#track-video'), overlay: $('#track-overlay'), audio: $('#track-audio'), text: $('#track-text') },
    isPlaying: () => engine.playing,
    onSelect: onClipSelected,
    onChange: () => { engine.recalc(); engine.applyGains(); updateDurationUI(); scheduleSave(); pushHistory(); },
    onScrub: (t) => { engine.seek(t); updateTimeUI(t); },
    onTransition: (clip) => openTransitionForClip(clip),
    getPlayhead: () => engine.playhead,
  });
}

async function main() {
  injectSheetChrome();
  initTimeline(); bindGlobal(); bindToolbar(); bindAdjust(); bindSpeed();
  bindTransition(); bindRatio(); bindText(); bindExport(); bindSettings(); bindAudioClip();
  bindGif(); bindPreviewGestures(); bindVoice(); bindColorCard();
  bindPro(); bindTutorial(); refreshProUI();
  await renderProjects();
  if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('sw.js'); } catch {} }
}
main();
