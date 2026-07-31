// app.js — Controlador principal de PlayCUT (v2 Pro).

import {
  createProject, createVideoClip, createAudioClip, createTextClip, createOverlayClip,
  clipDuration, projectDuration, videoClipAt, formatTime,
  normalizeProject, RATIOS,
} from './state.js';
import * as db from './db.js';
import { importFile, loadMediaRecord } from './media.js';
import { Engine } from './engine.js';
import { Timeline } from './timeline.js';
import { exportProject, computeExportSize } from './exporter.js';
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
  timeline.mediaThumbs = mediaThumbs; timeline.mediaNames = mediaNames;
  timeline.setProject(project); timeline.clearSelection();
  onClipSelected(null);

  els.projectName.value = project.name;
  updateDurationUI(); updateEmptyState();
  engine.seek(0); timeline.setPlayhead(0);
  resetHistory();
  showScreen('editor');
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
  toast('Importando…');
  for (const file of files) {
    try {
      const rec = await importFile(file);
      if (rec.thumb) mediaThumbs.set(rec.id, rec.thumb);
      mediaNames.set(rec.id, rec.name);
      if (rec.kind === 'audio') {
        project.tracks.audio.push(createAudioClip({ mediaId: rec.id, duration: rec.duration || 5, start: engine.playhead, name: rec.name }));
      } else {
        project.tracks.video.push(createVideoClip({ mediaId: rec.id, type: rec.kind, duration: rec.duration || 0, width: rec.width, height: rec.height }));
      }
    } catch (e) { console.error(e); toast('No se pudo importar ' + file.name); }
  }
  refresh(); pushHistory(); toast('¡Añadido!');
}

async function handleOverlayFiles(files) {
  if (!files.length) return;
  pushHistory();
  toast('Importando PiP…');
  let last = null;
  for (const file of files) {
    try {
      const rec = await importFile(file);
      if (rec.kind === 'audio') { toast('El PiP no admite audio suelto'); continue; }
      if (rec.thumb) mediaThumbs.set(rec.id, rec.thumb);
      mediaNames.set(rec.id, rec.name);
      const clip = createOverlayClip({ mediaId: rec.id, type: rec.kind, duration: rec.duration || 0, width: rec.width, height: rec.height, start: engine.playhead });
      project.tracks.overlay.push(clip); last = clip;
    } catch (e) { console.error(e); toast('No se pudo importar ' + file.name); }
  }
  refresh(); pushHistory();
  if (last) { timeline.select(last.id, 'overlay'); toast('PiP añadido — muévelo y ajústalo'); }
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
      case 'add-text': addTextAtPlayhead(false); break;
      case 'add-sticker': addTextAtPlayhead(true); break;
      case 'ratio': openRatioSheet(); break;
      case 'split': splitAtPlayhead(); break;
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

function onClipSelected(clip) {
  const has = !!clip;
  els.toolbarMain.hidden = has;
  els.clipTools.hidden = !has;
  if (has) haptic(8);
}

// ==================================================================
//  HOJAS
// ==================================================================
function openSheet(id) { els.backdrop.classList.add('show'); $('#' + id).classList.add('show'); }
function closeSheets() { els.backdrop.classList.remove('show'); $$('.sheet').forEach(s => { s.classList.remove('show'); s.style.transform = ''; }); }

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
  $('#adjust-title').textContent = track === 'audio' ? 'Audio' : track === 'overlay' ? 'PiP / Overlay' : isImage ? 'Imagen' : 'Video';
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
  set('#adj-opacity', Math.round((clip.opacity ?? 1) * 100));

  labelFor('#adj-volume').style.display = hasVolume ? '' : 'none';
  showLabels('only-audio', track === 'audio');
  showLabels('only-image', isImage);
  showLabels('only-visual', isVisual);

  setActive('#filters-row', 'filter', clip.filter || 'none');
  setActive('#motion-row', 'motion', clip.motion || 'none');
  setActive('#fill-row', 'fill', clip.fillMode || 'contain');
  $$('#fill-row [data-bg]').forEach(b => b.classList.toggle('active', clip.bg === b.dataset.bg));
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
  $$('.only-chroma').forEach(l => l.style.display = on ? '' : 'none');
}
function invalidateChroma(clip) { engine._chromaCache.delete(clip.id); }

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
  $('#out-opacity').textContent = $('#adj-opacity').value + '%';
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
    c.opacity = (+$('#adj-opacity').value) / 100;
    updateAdjustOutputs();
    engine.applyGains(); engine.render(engine.playhead); timeline.render(); updateDurationUI(); scheduleSave();
  };
  ['#adj-volume', '#adj-fadein', '#adj-fadeout', '#adj-duration', '#adj-scale', '#adj-rotate',
   '#adj-brightness', '#adj-contrast', '#adj-saturation', '#adj-opacity']
    .forEach(sel => $(sel).addEventListener('input', apply));

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
  $('#fill-row').addEventListener('click', (e) => {
    const fillBtn = e.target.closest('[data-fill]');
    const bgBtn = e.target.closest('[data-bg]');
    if (!adjustTarget) return;
    if (fillBtn) { adjustTarget.clip.fillMode = fillBtn.dataset.fill; setActive('#fill-row', 'fill', fillBtn.dataset.fill); }
    if (bgBtn) { adjustTarget.clip.bg = adjustTarget.clip.bg === bgBtn.dataset.bg ? 'black' : bgBtn.dataset.bg; $$('#fill-row [data-bg]').forEach(b => b.classList.toggle('active', adjustTarget.clip.bg === b.dataset.bg)); }
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
    engine.applyRatio(); refresh();
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
  $$('#text-colors .swatch').forEach(s => s.classList.toggle('active', s.dataset.color === clip.color));
  setActive('#text-fonts', 'font', clip.font || 'sans');
  setActive('#text-bg', 'bg', clip.bg || 'none');
  setActive('#text-anim', 'anim', clip.animIn || 'none');
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
    $('#out-textsize').textContent = textTarget.size;
    $('#out-texty').textContent = $('#text-y').value + '%';
    $('#out-textx').textContent = $('#text-x').value + '%';
    $('#out-textrot').textContent = $('#text-rot').value + '°';
    engine.render(engine.playhead); timeline.render(); scheduleSave();
  };
  ['#text-content', '#text-size', '#text-y', '#text-x', '#text-rot'].forEach(s => $(s).addEventListener('input', apply));
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
}
function sanitize(name) { return String(name).replace(/[^\w\-]+/g, '_').slice(0, 40) || 'playcut'; }

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
  els.fileAudio.addEventListener('change', (e) => { handleMediaFiles([...e.target.files]); e.target.value = ''; });
  els.btnSettings.addEventListener('click', openSettings);
  els.btnZoomIn.addEventListener('click', () => zoomBy(1.4));
  els.btnZoomOut.addEventListener('click', () => zoomBy(1 / 1.4));
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', () => { if (project) { timeline.render(); timeline.setPlayhead(engine.playhead); } });

  $('#timeline-scroll').addEventListener('click', (e) => {
    if (e.target.classList.contains('track') || e.target.classList.contains('timeline')) { timeline.clearSelection(); }
  });

  // Tocar la vista previa: cuentagotas > importar (si vacía) > play/pausa.
  $('.preview-wrap').addEventListener('click', (e) => {
    if (chromaPickMode) { pickChromaColor(e); return; }
    if (project.tracks.video.length === 0 && project.tracks.overlay.length === 0) els.fileMedia.click();
    else togglePlay();
  });

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
  initTimeline(); bindGlobal(); bindToolbar(); bindAdjust(); bindSpeed();
  bindTransition(); bindRatio(); bindText(); bindExport(); bindSettings(); bindAudioClip();
  await renderProjects();
  if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('sw.js'); } catch {} }
}
main();
