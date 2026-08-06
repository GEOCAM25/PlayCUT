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
import * as perf from './perf.js';

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
function showScreen(name) { for (const k in screens) screens[k].classList.toggle('active', k === name); }
function setActive(container, attr, value) {
  $$(`${container} [data-${attr}]`).forEach(b => b.classList.toggle('active', b.dataset[attr] === String(value)));
}

function scheduleSave() {
  if (!project) return;
  els.saveStatus.textContent = 'Guardando…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    project.thumb = engine.snapshot() || project.thumb;
    await db.saveProject(project);
    els.saveStatus.textContent = 'Guardado en el dispositivo ✓';
  }, 600);
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
  resetHistory();
  showScreen('editor');
  fitPreview();
  showTipsOnce();
}

function showTipsOnce() {
  if (localStorage.getItem('playcut.tips')) return;
  localStorage.setItem('playcut.tips', '1');
  setTimeout(() => toast('Consejo: toca un clip para editarlo y arrastra sus bordes para recortar'), 1000);
}

function setPlayIcon(playing) { els.btnPlay.textContent = playing ? '❚❚' : '▶'; }
function togglePlay() {
  if (engine.playing) { engine.pause(); setPlayIcon(false); }
  else { if (projectDuration(project) <= 0) { toast('Añade contenido primero'); return; } engine.play(); setPlayIcon(true); }
}

async function handleMediaFiles(files) {
  if (!files.length) return;
  pushHistory();
  let added = 0, lastVideo = null;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    toast(files.length > 1 ? `Importando ${i + 1} de ${files.length}…` : 'Importando…');
    try {
      const rec = await importFile(file);
      if (rec.thumb) mediaThumbs.set(rec.id, rec.thumb);
      mediaNames.set(rec.id, rec.name);
      if (rec.kind === 'audio') {
        project.tracks.audio.push(createAudioClip({ mediaId: rec.id, duration: rec.duration || 5, start: engine.playhead, name: rec.name }));
        ensurePeaks(rec.id);
      } else {
        const clip = createVideoClip({ mediaId: rec.id, type: rec.kind, duration: rec.duration || 0, width: rec.width, height: rec.height });
        project.tracks.video.push(clip); lastVideo = clip;
      }
      added++;
    } catch (e) {
      console.error(e);
      const quota = /quota|exceeded|storage|space|full/i.test((e && (e.name + ' ' + e.message)) || '');
      toast(quota ? 'No hay espacio en el dispositivo para ese archivo' : ('No se pudo importar ' + (file.name || 'el archivo')));
    }
  }
  refresh();
  void lastVideo;
  pushHistory();
  if (added) toast('¡Añadido! Toca el clip para editarlo o pellízcalo con 2 dedos');
}

async function handleOverlayFiles(files) {
  if (!files.length) return;
  pushHistory();
  toast('Importando superposición…');
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
  refresh(); pushHistory();
  if (last) { timeline.select(last.id, 'overlay'); toast('Superposición añadida — muévela y ajústala'); }
}

// Importa audio. Si es un VIDEO, extrae su audio y lo convierte a MP3.
async function handleAudioFiles(files) {
  if (!files.length) return;
  pushHistory();
  for (const file of files) {
    try {
      let audioFile = file;
      if (file.type.startsWith('video')) {
        toast('Extrayendo audio y convirtiendo a MP3…');
        const mp3 = await mediaToMp3(file, () => {});
        const base = (file.name.replace(/\.[^.]+$/, '') || 'audio');
        audioFile = new File([mp3], base + '.mp3', { type: 'audio/mpeg' });
      }
      const rec = await importFile(audioFile);
      mediaNames.set(rec.id, rec.name);
      project.tracks.audio.push(createAudioClip({ mediaId: rec.id, duration: rec.duration || 5, start: engine.playhead, name: rec.name }));
      ensurePeaks(rec.id);
    } catch (e) { console.error(e); toast('No se pudo procesar el audio: ' + (e.message || '')); }
  }
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

const EMOJIS = ['😀', '😂', '🥰', '😎', '😭', '😱', '🤔', '😴', '🤩', '🥳', '😍', '🤣', '😤', '🙄', '😇', '🤗', '🥺', '😏', '🔥', '✨', '⭐', '🌟', '💫', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💯', '👍', '👎', '👏', '🙌', '🙏', '🤙', '👀', '💪', '🎉', '🎊', '🎈', '🎁', '👑', '💎', '💰', '⚡', '💥', '💦', '🌈', '☀️', '🌙', '⚽', '🏆', '🎵', '🎮', '📌', '✅', '❌', '❓', '❗', '💤', '🍕', '🍔', '🌮', '🍟', '🐶', '🐱', '🦄'];
function buildEmojiGrid() {
  const grid = $('#emoji-grid'); if (!grid || grid.childElementCount) return;
  for (const e of EMOJIS) {
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

// Congela el fotograma actual: lo captura como imagen y lo inserta como clip fijo.
async function freezeFrame() {
  const clips = project.tracks.video;
  const at = videoClipAt(clips, engine.playhead);
  if (!at) { toast('Coloca el cursor sobre un video o foto para congelar'); return; }
  try {
    toast('Congelando fotograma…');
    const blob = await engine.captureBaseFrame();
    if (!blob) { toast('No se pudo capturar el fotograma'); return; }
    const file = new File([blob], 'congelado.png', { type: 'image/png' });
    pushHistory();
    const rec = await importFile(file);
    if (rec.thumb) mediaThumbs.set(rec.id, rec.thumb);
    mediaNames.set(rec.id, 'Congelado');
    const clip = createVideoClip({ mediaId: rec.id, type: 'image', duration: 0, width: rec.width, height: rec.height });
    clip.imageDuration = 2;
    clips.splice(at.index + 1, 0, clip);
    refresh(); pushHistory(); timeline.select(clip.id, 'video');
    haptic(15); toast('🧊 Fotograma congelado (2s) añadido');
  } catch (e) { console.error(e); toast('No se pudo congelar: ' + (e.message || '')); }
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
  if (has) haptic(8);
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
    btn.textContent = '✕';
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
  $$('.only-overlay').forEach(l => l.style.display = track === 'overlay' ? (l.classList.contains('opt-chips') ? 'flex' : 'block') : 'none');
  setActive('#blend-row', 'blend', clip.blend || 'normal');
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
    if (c.keyframes && c.keyframes.length) { upsertKeyframe(c, adjustTarget.track); updateKfUI(c); }
    updateAdjustOutputs();
    engine.applyGains(); engine.render(engine.playhead); timeline.render(); updateDurationUI(); scheduleSave();
  };
  ['#adj-volume', '#adj-fadein', '#adj-fadeout', '#adj-duration', '#adj-scale', '#adj-rotate',
   '#adj-brightness', '#adj-contrast', '#adj-saturation', '#adj-temp', '#adj-hue', '#adj-vignette', '#adj-grain', '#adj-opacity',
   '#adj-animindur', '#adj-animoutdur']
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
    adjustTarget.clip.blend = b.dataset.blend; setActive('#blend-row', 'blend', b.dataset.blend);
    engine.render(engine.playhead); scheduleSave();
  });
  $('#mask-row').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mask]'); if (!b || !adjustTarget) return;
    adjustTarget.clip.mask = b.dataset.mask; setActive('#mask-row', 'mask', b.dataset.mask);
    engine.render(engine.playhead); timeline.render(); scheduleSave();
  });
  $('#kf-add').addEventListener('click', () => {
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
    engine.render(engine.playhead); timeline.render(); scheduleSave();
  };
  ['#text-content', '#text-size', '#text-y', '#text-x', '#text-rot', '#text-ls'].forEach(s => $(s).addEventListener('input', apply));
  const fx = $('#text-effects');
  if (fx) fx.addEventListener('click', (e) => {
    const b = e.target.closest('[data-toggle]'); if (!b || !textTarget) return;
    if (b.dataset.toggle === 'shadow') { textTarget.shadow = !textTarget.shadow; b.classList.toggle('active', !!textTarget.shadow); }
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
function openSettings() {
  $('#device-info').textContent = perf.deviceSummary();
  setActive('#perf-grid', 'perf', perf.getMode());
  $$('#bg-colors .swatch').forEach(s => s.classList.toggle('active', s.dataset.color === project.bgColor));
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
  $('#export-res').addEventListener('click', (e) => { const b = e.target.closest('[data-res]'); if (!b) return; exportRes = +b.dataset.res; setActive('#export-res', 'res', exportRes); updateExportMeta(); });
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
}
let lastExportBlob = null, lastExportName = '';
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
      const t = gestureTarget();
      g = { mode: 'maybe', t, sx: e.clientX, sy: e.clientY, moved: false,
        oScale: t ? (t.clip.scale ?? 1) : 1, oSize: t ? (t.clip.size ?? 64) : 64,
        oX: t ? (t.track === 'text' ? (t.clip.x ?? 0.5) : (t.clip.offsetX ?? 0)) : 0,
        oY: t ? (t.track === 'text' ? (t.clip.y ?? 0.8) : (t.clip.offsetY ?? 0)) : 0 };
    } else if (pointers.size === 2) {
      const t = gestureTarget();
      if (t) {
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
  bindGif(); bindPreviewGestures(); bindVoice();
  await renderProjects();
  if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('sw.js'); } catch {} }
}
main();
