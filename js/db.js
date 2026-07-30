// db.js — Persistencia 100% local con IndexedDB.
// Guarda proyectos y archivos multimedia (como Blobs) en el propio dispositivo.
// Nada de esto sale del teléfono.

const DB_NAME = 'playcut';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_MEDIA = 'media';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_MEDIA)) {
        db.createObjectStore(STORE_MEDIA, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode = 'readonly') {
  return openDB().then((db) => db.transaction(store, mode).objectStore(store));
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---------- Proyectos ----------
export async function saveProject(project) {
  project.updatedAt = Date.now();
  const store = await tx(STORE_PROJECTS, 'readwrite');
  return reqToPromise(store.put(project));
}

export async function getProject(id) {
  const store = await tx(STORE_PROJECTS);
  return reqToPromise(store.get(id));
}

export async function getAllProjects() {
  const store = await tx(STORE_PROJECTS);
  const all = await reqToPromise(store.getAll());
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(id) {
  const project = await getProject(id);
  const store = await tx(STORE_PROJECTS, 'readwrite');
  await reqToPromise(store.delete(id));
  // Borra los medios que ya no usa ningún proyecto.
  if (project) await cleanupOrphanMedia();
}

// ---------- Medios ----------
export async function saveMedia(media) {
  const store = await tx(STORE_MEDIA, 'readwrite');
  return reqToPromise(store.put(media));
}

export async function getMedia(id) {
  const store = await tx(STORE_MEDIA);
  return reqToPromise(store.get(id));
}

export async function getAllMedia() {
  const store = await tx(STORE_MEDIA);
  return reqToPromise(store.getAll());
}

async function cleanupOrphanMedia() {
  const [projects, media] = await Promise.all([getAllProjects(), getAllMedia()]);
  const used = new Set();
  for (const p of projects) {
    for (const track of ['video', 'audio']) {
      for (const clip of p.tracks[track] || []) used.add(clip.mediaId);
    }
  }
  const store = await tx(STORE_MEDIA, 'readwrite');
  for (const m of media) {
    if (!used.has(m.id)) store.delete(m.id);
  }
}

// ---------- Uso de almacenamiento ----------
export async function estimateStorage() {
  if (navigator.storage && navigator.storage.estimate) {
    return navigator.storage.estimate();
  }
  return { usage: 0, quota: 0 };
}
