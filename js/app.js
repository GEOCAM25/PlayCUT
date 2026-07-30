// app.js — Controlador principal de PlayCUT.

import {
  createProject, createVideoClip, createAudioClip, createTextClip,
  clipDuration, projectDuration, videoClipAt, formatTime,
} from './state.js';
import * as db from './db.js';
import { importFile, loadMediaRecord } from './media.js';
import { Engine } from './engine.js';
import { Timeline, PPS } from './timeline.js';
import { exportProject } from './exporter.js';

// ---------- Referencias del DOM ----------
const $ = (sel) => document.querySelector(sel);
const screens = { home: $('#screen-home'), editor: $('#screen-editor') };

const els = {
  projectList: $('#project-list'),
  emptyProjects: $('#empty-projects'),
  btnNew: $('#btn-new-project'),
  btnInstall: $('#btn-install'),
  btnBack: $('#btn-back'),
  projectName: $('#project-name'),
  saveStatus: $('#save-status'),
  btnExport: $('#btn-export'),
  canvas: $('#preview'),
  previewEmpty: $('#preview-empty'),
  btnPlay: $('#btn-play'),
  timeCurrent: $('#time-current'),
  timeTotal: $('#time-total'),
  seek: $('#seek'),
  toolbarMain: $('#toolbar-main'),
  clipTools: $('#clip-tools'),
  fileMedia: $('#file-media'),
  fileAudio: $('#file-audio'),
  toast: $('#toast'),
  backdrop: $('#sheet-backdrop'),
};

// ---------- Estado ----------
let engine = new Engine(els.canvas);
let timeline = null;
let project = null;
let saveTimer = null;
let deferredInstall = null;

// Mapas para el timeline (miniaturas y nombres de medios)
const mediaThumbs = new Map();
const mediaNames = new Map();

// ---------- Utilidades ----------
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove('show'), 2200);
}

function showScreen(name) {
  for (const k in screens) screens[k].classList.toggle('active', k === name);
}

function scheduleSave() {
  if (!project) return;
  els.saveStatus.textContent = 'Guardando…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    project.thumb = engine.snapshot() || project.thumb;
    await db.saveProject(project);
    els.saveStatus.textContent = 'Guardado';
  }, 600);
}

// Recalcula motor + timeline + UI tras un cambio estructural.
function refresh() {
  engine.recalc();
  engine.syncElements();
  engine.applyGains();
  timeline.render();
  updateDurationUI();
  updateEmptyState();
  engine.render(engine.playhead);
  scheduleSave();
}

function updateDurationUI() {
  const total = projectDuration(project);
  els.timeTotal.textContent = formatTime(total);
  updateTimeUI(engine.playhead);
}

function updateTimeUI(t) {
  els.timeCurrent.textContent = formatTime(t);
  const total = projectDuration(project) || 1;
  els.seek.value = Math.round((t / total) * 1000);
}

function updateEmptyState() {
  const empty = project.tracks.video.length === 0;
  els.previewEmpty.hidden = !empty;
}

// ==================================================================
//  PANTALLA DE PROYECTOS
// ==================================================================
async function renderProjects() {
  const projects = await db.getAllProjects();
  els.projectList.innerHTML = '';
  els.emptyProjects.hidden = projects.length > 0;
  for (const p of projects) {
    const card = document.createElement('div');
    card.className = 'project-card';
    const thumb = document.createElement('div');
    thumb.className = 'project-thumb';
    if (p.thumb) thumb.style.backgroundImage = `url(${p.thumb})`;
    else thumb.textContent = '🎬';
    const meta = document.createElement('div');
    meta.className = 'project-meta';
    const dur = formatTime(projectDuration(p));
    meta.innerHTML = `<h3>${escapeHtml(p.name)}</h3><span>${dur} · ${new Date(p.updatedAt).toLocaleDateString()}</span>`;
    const del = document.createElement('button');
    del.className = 'project-del'; del.textContent = '×';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`¿Borrar "${p.name}"? Esto no se puede deshacer.`)) {
        await db.deleteProject(p.id);
        renderProjects();
        toast('Proyecto borrado');
      }
    });
    card.appendChild(thumb); card.appendChild(meta); card.appendChild(del);
    card.addEventListener('click', () => openProject(p.id));
    els.projectList.appendChild(card);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function newProject() {
  const p = createProject('Proyecto ' + new Date().toLocaleDateString());
  await db.saveProject(p);
  await openProject(p.id);
}

// ==================================================================
//  EDITOR
// ==================================================================
async function openProject(id) {
  project = await db.getProject(id);
  if (!project) { toast('No se encontró el proyecto'); return; }

  // Precarga miniaturas/nombres de los medios usados.
  mediaThumbs.clear(); mediaNames.clear();
  const ids = new Set();
  for (const c of project.tracks.video) ids.add(c.mediaId);
  for (const c of project.tracks.audio) ids.add(c.mediaId);
  for (const mid of ids) {
    const rec = await loadMediaRecord(mid);
    if (rec) { if (rec.thumb) mediaThumbs.set(mid, rec.thumb); mediaNames.set(mid, rec.name); }
  }

  engine.setProject(project);
  engine.onTick = (t, ended) => {
    updateTimeUI(t);
    timeline.setPlayhead(t);
    if (ended) setPlayIcon(false);
  };

  timeline.mediaThumbs = mediaThumbs;
  timeline.mediaNames = mediaNames;
  timeline.setProject(project);
  timeline.clearSelection();

  els.projectName.value = project.name;
  updateDurationUI();
  updateEmptyState();
  engine.seek(0);
  timeline.setPlayhead(0);
  showScreen('editor');
}

function setPlayIcon(playing) {
  els.btnPlay.textContent = playing ? '❚❚' : '▶';
}

function togglePlay() {
  if (engine.playing) { engine.pause(); setPlayIcon(false); }
  else {
    if (projectDuration(project) <= 0) { toast('Añade contenido primero'); return; }
    engine.play(); setPlayIcon(true);
  }
}

// ---------- Importación de medios ----------
async function handleMediaFiles(files) {
  if (!files.length) return;
  toast('Importando…');
  for (const file of files) {
    try {
      const rec = await importFile(file);
      if (rec.thumb) mediaThumbs.set(rec.id, rec.thumb);
      mediaNames.set(rec.id, rec.name);
      if (rec.kind === 'audio') {
        const clip = createAudioClip({ mediaId: rec.id, duration: rec.duration || 5, start: engine.playhead });
        project.tracks.audio.push(clip);
      } else {
        const clip = createVideoClip({
          mediaId: rec.id, type: rec.kind, duration: rec.duration || 0,
          width: rec.width, height: rec.height,
        });
        project.tracks.video.push(clip);
      }
    } catch (e) {
      console.error(e);
      toast('No se pudo importar ' + file.name);
    }
  }
  refresh();
  toast('¡Añadido!');
}

// ==================================================================
//  ACCIONES DE LA BARRA PRINCIPAL
// ==================================================================
function bindToolbar() {
  els.toolbarMain.addEventListener('click', (e) => {
    const btn = e.target.closest('.tool');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'add-media') els.fileMedia.click();
    else if (action === 'add-audio') els.fileAudio.click();
    else if (action === 'add-text') addTextAtPlayhead();
    else if (action === 'split') splitAtPlayhead();
    else if (action === 'adjust') {
      const sel = getSelectedClip();
      if (sel) openAdjustSheet(sel.clip, sel.track);
      else toast('Selecciona un clip para ajustar');
    }
  });

  els.clipTools.addEventListener('click', (e) => {
    const btn = e.target.closest('.tool');
    if (!btn) return;
    const action = btn.dataset.action;
    const sel = getSelectedClip();
    if (!sel) return;
    switch (action) {
      case 'clip-left': moveClip(sel, -1); break;
      case 'clip-right': moveClip(sel, 1); break;
      case 'clip-split': splitAtPlayhead(); break;
      case 'clip-duplicate': duplicateClip(sel); break;
      case 'clip-delete': deleteClip(sel); break;
      case 'clip-adjust':
        if (sel.track === 'text') openTextSheet(sel.clip);
        else openAdjustSheet(sel.clip, sel.track);
        break;
    }
  });
}

function getSelectedClip() {
  if (!timeline.selectedId) return null;
  const track = timeline.selectedTrack;
  const clip = (project.tracks[track] || []).find(c => c.id === timeline.selectedId);
  return clip ? { clip, track } : null;
}

function addTextAtPlayhead() {
  const start = engine.playhead;
  const end = Math.min(start + 3, projectDuration(project) || start + 3);
  const clip = createTextClip({ text: 'Toca para editar', start, end: end > start ? end : start + 3 });
  project.tracks.text.push(clip);
  refresh();
  timeline.select(clip.id, 'text');
  openTextSheet(clip);
}

function splitAtPlayhead() {
  const t = engine.playhead;
  const clips = project.tracks.video;
  const at = videoClipAt(clips, t);
  if (!at || at.localTime < 0.15 || clipDuration(at.clip) - at.localTime < 0.15) {
    toast('Coloca el cursor dentro de un clip');
    return;
  }
  const original = at.clip;
  const idx = at.index;
  const copy = JSON.parse(JSON.stringify(original));
  copy.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  if (original.type === 'video') {
    const cut = original.inPoint + at.localTime;
    copy.inPoint = cut;
    copy.outPoint = original.outPoint;
    original.outPoint = cut;
  } else {
    const full = original.imageDuration;
    original.imageDuration = at.localTime;
    copy.imageDuration = Math.max(0.2, full - at.localTime);
  }
  clips.splice(idx + 1, 0, copy);
  refresh();
  timeline.select(copy.id, 'video');
  toast('Clip dividido');
}

function moveClip(sel, dir) {
  if (sel.track !== 'video') { toast('Solo se reordenan los clips de video'); return; }
  const clips = project.tracks.video;
  const i = clips.findIndex(c => c.id === sel.clip.id);
  const j = i + dir;
  if (j < 0 || j >= clips.length) return;
  [clips[i], clips[j]] = [clips[j], clips[i]];
  refresh();
  timeline.select(sel.clip.id, 'video');
}

function duplicateClip(sel) {
  const copy = JSON.parse(JSON.stringify(sel.clip));
  copy.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const arr = project.tracks[sel.track];
  const i = arr.findIndex(c => c.id === sel.clip.id);
  if (sel.track === 'audio' || sel.track === 'text') {
    const dur = sel.track === 'audio' ? (copy.outPoint - copy.inPoint) : (copy.end - copy.start);
    if (sel.track === 'text') { copy.start += dur; copy.end += dur; }
    else copy.start += dur;
  }
  arr.splice(i + 1, 0, copy);
  refresh();
  timeline.select(copy.id, sel.track);
  toast('Clip duplicado');
}

function deleteClip(sel) {
  const arr = project.tracks[sel.track];
  const i = arr.findIndex(c => c.id === sel.clip.id);
  if (i >= 0) arr.splice(i, 1);
  timeline.clearSelection();
  refresh();
  toast('Clip borrado');
}

// ==================================================================
//  SELECCIÓN (mostrar barra contextual)
// ==================================================================
function onClipSelected(clip, track) {
  const has = !!clip;
  els.toolbarMain.hidden = has;
  els.clipTools.hidden = !has;
}

// ==================================================================
//  HOJAS (bottom sheets)
// ==================================================================
function openSheet(id) {
  els.backdrop.classList.add('show');
  $('#' + id).classList.add('show');
}
function closeSheets() {
  els.backdrop.classList.remove('show');
  document.querySelectorAll('.sheet').forEach(s => s.classList.remove('show'));
}

// ---------- Ajustes de clip ----------
let adjustTarget = null;
function openAdjustSheet(clip, track) {
  adjustTarget = { clip, track };
  const isImage = clip.type === 'image';
  const isVisual = track === 'video';
  $('#adjust-title').textContent = isImage ? 'Ajustes de imagen' : (track === 'audio' ? 'Ajustes de audio' : 'Ajustes de video');
  setRange('#adj-volume', Math.round((clip.volume ?? 1) * 100));
  setRange('#adj-duration', clip.imageDuration ?? 3);
  setRange('#adj-brightness', Math.round((clip.brightness ?? 1) * 100));
  setRange('#adj-contrast', Math.round((clip.contrast ?? 1) * 100));
  setRange('#adj-saturation', Math.round((clip.saturation ?? 1) * 100));
  setRange('#adj-opacity', Math.round((clip.opacity ?? 1) * 100));
  // Mostrar/ocultar controles según el tipo
  labelFor('#adj-duration').style.display = isImage ? '' : 'none';
  ['#adj-brightness', '#adj-contrast', '#adj-saturation', '#adj-opacity'].forEach(s => {
    labelFor(s).style.display = isVisual ? '' : 'none';
  });
  $('#filters-row').style.display = isVisual ? '' : 'none';
  document.querySelectorAll('#filters-row .chip').forEach(c => c.classList.toggle('active', c.dataset.filter === (clip.filter || 'none')));
  updateAdjustOutputs();
  openSheet('sheet-adjust');
}

function labelFor(inputSel) { return $(inputSel).closest('label') || $(inputSel).parentElement; }
function setRange(sel, val) { $(sel).value = val; }

function updateAdjustOutputs() {
  $('#out-volume').textContent = $('#adj-volume').value + '%';
  $('#out-duration').textContent = (+$('#adj-duration').value).toFixed(1) + 's';
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
    if (c.type === 'image') c.imageDuration = +$('#adj-duration').value;
    c.brightness = (+$('#adj-brightness').value) / 100;
    c.contrast = (+$('#adj-contrast').value) / 100;
    c.saturation = (+$('#adj-saturation').value) / 100;
    c.opacity = (+$('#adj-opacity').value) / 100;
    updateAdjustOutputs();
    engine.applyGains();
    engine.render(engine.playhead);
    timeline.render();
    updateDurationUI();
    scheduleSave();
  };
  ['#adj-volume', '#adj-duration', '#adj-brightness', '#adj-contrast', '#adj-saturation', '#adj-opacity']
    .forEach(sel => $(sel).addEventListener('input', apply));
  document.querySelectorAll('#filters-row .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      if (!adjustTarget) return;
      adjustTarget.clip.filter = chip.dataset.filter;
      document.querySelectorAll('#filters-row .chip').forEach(c => c.classList.toggle('active', c === chip));
      engine.render(engine.playhead);
      scheduleSave();
    });
  });
}

// ---------- Texto ----------
let textTarget = null;
function openTextSheet(clip) {
  textTarget = clip;
  $('#text-content').value = clip.text || '';
  setRange('#text-size', clip.size || 64);
  setRange('#text-y', Math.round((clip.y ?? 0.8) * 100));
  $('#out-textsize').textContent = clip.size || 64;
  $('#out-texty').textContent = Math.round((clip.y ?? 0.8) * 100) + '%';
  document.querySelectorAll('#text-colors .swatch').forEach(s => s.classList.toggle('active', s.dataset.color === clip.color));
  openSheet('sheet-text');
}

function bindText() {
  const apply = () => {
    if (!textTarget) return;
    textTarget.text = $('#text-content').value || ' ';
    textTarget.size = +$('#text-size').value;
    textTarget.y = (+$('#text-y').value) / 100;
    $('#out-textsize').textContent = textTarget.size;
    $('#out-texty').textContent = $('#text-y').value + '%';
    engine.render(engine.playhead);
    timeline.render();
    scheduleSave();
  };
  $('#text-content').addEventListener('input', apply);
  $('#text-size').addEventListener('input', apply);
  $('#text-y').addEventListener('input', apply);
  document.querySelectorAll('#text-colors .swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      if (!textTarget) return;
      textTarget.color = sw.dataset.color;
      document.querySelectorAll('#text-colors .swatch').forEach(s => s.classList.toggle('active', s === sw));
      engine.render(engine.playhead);
      scheduleSave();
    });
  });
  $('#text-delete').addEventListener('click', () => {
    if (!textTarget) return;
    const i = project.tracks.text.findIndex(c => c.id === textTarget.id);
    if (i >= 0) project.tracks.text.splice(i, 1);
    textTarget = null;
    timeline.clearSelection();
    closeSheets();
    refresh();
  });
}

// ==================================================================
//  EXPORTAR
// ==================================================================
function bindExport() {
  els.btnExport.addEventListener('click', () => {
    if (projectDuration(project) <= 0) { toast('El proyecto está vacío'); return; }
    $('#export-config').hidden = false;
    $('#export-progress').hidden = true;
    $('#export-done').hidden = true;
    openSheet('sheet-export');
  });

  $('#btn-start-export').addEventListener('click', async () => {
    const quality = +document.querySelector('input[name="quality"]:checked').value;
    $('#export-config').hidden = true;
    $('#export-progress').hidden = false;
    setPlayIcon(false);
    try {
      const { blob, ext } = await exportProject(engine, {
        quality,
        onProgress: (p) => {
          $('#export-percent').textContent = p + '%';
          $('#export-bar').style.width = p + '%';
        },
      });
      const url = URL.createObjectURL(blob);
      $('#export-preview').src = url;
      const link = $('#export-download');
      link.href = url;
      link.download = `${sanitize(project.name)}.${ext}`;
      $('#export-progress').hidden = true;
      $('#export-done').hidden = false;
    } catch (e) {
      console.error(e);
      toast('Error al exportar: ' + (e.message || e));
      closeSheets();
    }
  });
}

function sanitize(name) {
  return String(name).replace(/[^\w\-]+/g, '_').slice(0, 40) || 'playcut';
}

// ==================================================================
//  ENLACES DE EVENTOS GENERALES
// ==================================================================
function bindGlobal() {
  els.btnNew.addEventListener('click', newProject);
  els.btnBack.addEventListener('click', () => {
    engine.pause(); setPlayIcon(false);
    scheduleSave();
    showScreen('home');
    renderProjects();
  });
  els.projectName.addEventListener('input', () => { project.name = els.projectName.value; scheduleSave(); });
  els.btnPlay.addEventListener('click', togglePlay);

  els.seek.addEventListener('input', () => {
    engine.pause(); setPlayIcon(false);
    const total = projectDuration(project);
    const t = (els.seek.value / 1000) * total;
    engine.seek(t);
    timeline.setPlayhead(t);
    updateTimeUI(t);
  });

  els.fileMedia.addEventListener('change', (e) => { handleMediaFiles([...e.target.files]); e.target.value = ''; });
  els.fileAudio.addEventListener('change', (e) => { handleMediaFiles([...e.target.files]); e.target.value = ''; });

  // Deseleccionar al tocar el fondo del timeline
  $('#timeline-scroll').addEventListener('click', (e) => {
    if (e.target.classList.contains('track') || e.target.classList.contains('timeline')) {
      timeline.clearSelection();
    }
  });

  els.backdrop.addEventListener('click', closeSheets);
  document.querySelectorAll('[data-close-sheet]').forEach(b => b.addEventListener('click', closeSheets));

  // Instalación PWA
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    els.btnInstall.hidden = false;
  });
  els.btnInstall.addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    els.btnInstall.hidden = true;
  });
}

// ==================================================================
//  INICIALIZACIÓN
// ==================================================================
function initTimeline() {
  timeline = new Timeline({
    root: $('#timeline'),
    scroll: $('#timeline-scroll'),
    trackEls: { video: $('#track-video'), audio: $('#track-audio'), text: $('#track-text') },
    isPlaying: () => engine.playing,
    onSelect: onClipSelected,
    onChange: () => { engine.recalc(); engine.applyGains(); updateDurationUI(); scheduleSave(); },
    onScrub: (t) => { engine.seek(t); updateTimeUI(t); },
  });
}

async function main() {
  initTimeline();
  bindGlobal();
  bindToolbar();
  bindAdjust();
  bindText();
  bindExport();
  await renderProjects();

  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (e) { /* offline opcional */ }
  }
}

main();
