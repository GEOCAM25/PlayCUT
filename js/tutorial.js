// tutorial.js — Guía para principiantes, con pasos que señalan cada botón.
// Se muestra sola la primera vez y se puede repetir desde Ajustes.

const TUT_KEY = 'playcut.tutorialDone';

const TUT_STEPS = [
  {
    sel: '[data-action="add-media"]',
    title: 'Añade tu primer video o foto',
    body: 'Toca aquí para elegir videos y fotos de tu teléfono. Puedes seleccionar varios a la vez.',
  },
  {
    sel: '.timeline-scroll',
    title: 'Esta es tu línea de tiempo',
    body: 'Aquí van tus clips en orden. Arrastra a los lados para moverte por el video, y toca un clip para seleccionarlo.',
    place: 'top',
  },
  {
    sel: '#btn-play',
    title: 'Reproduce para ver el resultado',
    body: 'Toca para reproducir o pausar. La línea blanca te indica en qué momento estás.',
    place: 'top',
  },
  {
    sel: '[data-action="split"]',
    title: 'Corta por donde quieras',
    body: 'Coloca la línea blanca donde quieras cortar y toca Dividir. Así separas un clip en dos.',
  },
  {
    sel: '[data-action="add-text"]',
    title: 'Pon textos y stickers',
    body: 'Añade títulos, subtítulos o emojis. Después puedes arrastrarlos por el video con el dedo.',
  },
  {
    sel: '[data-action="add-audio"]',
    title: 'Ponle música o tu voz',
    body: 'Añade una canción, o usa Voz para narrar. Si eliges un video, la app saca su audio en MP3.',
  },
  {
    sel: '#btn-export',
    title: 'Guarda tu video terminado',
    body: 'Cuando acabes, exporta en la calidad que quieras (hasta 4K) y compártelo. Todo se hace en tu teléfono.',
    place: 'bottom',
  },
  {
    sel: '#btn-settings',
    title: 'Puedes repetir esta guía',
    body: 'En Ajustes tienes «Ver guía para principiantes» siempre disponible. ¡Listo, a crear!',
    place: 'bottom',
  },
];

let tutIdx = 0, tutActive = false, tutEls = null, tutOnEnd = null;

export function tutorialSeen() { return localStorage.getItem(TUT_KEY) === '1'; }
export function markSeen() { localStorage.setItem(TUT_KEY, '1'); }

function tutBuild() {
  if (tutEls) return tutEls;
  const root = document.createElement('div');
  root.className = 'tut-root';
  root.innerHTML = `
    <div class="tut-mask" id="tut-mask"></div>
    <div class="tut-ring" id="tut-ring"></div>
    <div class="tut-card" id="tut-card">
      <div class="tut-step" id="tut-step"></div>
      <h4 id="tut-title"></h4>
      <p id="tut-body"></p>
      <div class="tut-actions">
        <button class="ghost-btn" id="tut-skip">Saltar</button>
        <button class="primary-btn" id="tut-next">Siguiente</button>
      </div>
    </div>`;
  document.body.appendChild(root);
  tutEls = {
    root, mask: root.querySelector('#tut-mask'), ring: root.querySelector('#tut-ring'),
    card: root.querySelector('#tut-card'), step: root.querySelector('#tut-step'),
    title: root.querySelector('#tut-title'), body: root.querySelector('#tut-body'),
    skip: root.querySelector('#tut-skip'), next: root.querySelector('#tut-next'),
  };
  tutEls.skip.addEventListener('click', () => end());
  tutEls.next.addEventListener('click', () => { tutIdx++; tutRender(); });
  tutEls.mask.addEventListener('click', () => { tutIdx++; tutRender(); });
  window.addEventListener('resize', () => { if (tutActive) tutRender(); });
  return tutEls;
}

function tutRender() {
  if (tutIdx >= TUT_STEPS.length) { end(); return; }
  const s = TUT_STEPS[tutIdx];
  const e = tutBuild();
  const target = document.querySelector(s.sel);
  if (!target) { tutIdx++; return tutRender(); }

  // Lleva el objetivo a la vista si está en una barra desplazable.
  try { target.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); } catch {}

  requestAnimationFrame(() => {
    const r = target.getBoundingClientRect();
    const pad = 8;
    e.ring.style.left = (r.left - pad) + 'px';
    e.ring.style.top = (r.top - pad) + 'px';
    e.ring.style.width = (r.width + pad * 2) + 'px';
    e.ring.style.height = (r.height + pad * 2) + 'px';

    e.step.textContent = `Paso ${tutIdx + 1} de ${TUT_STEPS.length}`;
    e.title.textContent = s.title;
    e.body.textContent = s.body;
    e.next.textContent = tutIdx === TUT_STEPS.length - 1 ? '¡Entendido!' : 'Siguiente';

    // Coloca la tarjeta arriba o abajo del objetivo, la que tenga más sitio.
    const vh = window.innerHeight;
    const below = vh - r.bottom, above = r.top;
    const place = s.place || (below > above ? 'bottom' : 'top');
    e.card.classList.toggle('is-top', place === 'top');
    const cardH = e.card.offsetHeight || 190;
    let top = place === 'bottom' ? r.bottom + 14 : r.top - cardH - 14;
    top = Math.max(12, Math.min(top, vh - cardH - 12));
    e.card.style.top = top + 'px';
  });
}

export function start(onEnd) {
  tutIdx = 0; tutActive = true; tutOnEnd = onEnd || null;
  tutBuild();
  tutEls.root.classList.add('show');
  document.body.classList.add('tut-open');
  tutRender();
}

export function end() {
  tutActive = false;
  markSeen();
  if (tutEls) tutEls.root.classList.remove('show');
  document.body.classList.remove('tut-open');
  if (tutOnEnd) { const cb = tutOnEnd; tutOnEnd = null; cb(); }
}

export function isActive() { return tutActive; }
