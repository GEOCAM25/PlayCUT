// build-single.js — Empaqueta toda la app en un único HTML autocontenido.
// Une los módulos ES (quitando import/export), incrusta el CSS y el icono,
// y quita el service worker (no aplica en un solo archivo).

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const R = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// Orden de dependencias.
const order = ['js/state.js', 'js/db.js', 'js/media.js', 'js/perf.js', 'js/audioextract.js', 'js/gifencoder.js', 'js/reverse.js', 'js/pro.js', 'js/tutorial.js', 'js/engine.js', 'js/exporter.js', 'js/timeline.js', 'js/app.js'];

function strip(src) {
  // Quita imports (incluye multilínea).
  src = src.replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];?/g, '');
  // Quita el prefijo export al inicio de línea.
  src = src.replace(/^(\s*)export\s+/gm, '$1');
  // Quita el registro del service worker.
  src = src.replace(/if \('serviceWorker' in navigator\)[^\n]*\n?/g, '');
  return src;
}

// Nombres exportados de un módulo (para reconstruir namespaces).
function exportedNames(src) {
  const names = new Set();
  const re = /export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g;
  let m; while ((m = re.exec(src))) names.add(m[1]);
  return [...names];
}

// Detecta `import * as X from './file.js'` en todos los módulos.
const nsByFile = {};
for (const f of order) {
  const src = R(f);
  const re = /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]\.\/([\w-]+)\.js['"]/g;
  let m; while ((m = re.exec(src))) nsByFile[m[2] + '.js'] = m[1];
}

const bundle = order.map(f => {
  let out = `\n/* ===== ${f} ===== */\n` + strip(R(f));
  const base = f.replace('js/', '');
  if (nsByFile[base]) {
    const names = exportedNames(R(f));
    out += `\n/* namespace ${nsByFile[base]} */\nconst ${nsByFile[base]} = { ${names.join(', ')} };\n`;
  }
  return out;
}).join('\n');
const css = R('css/styles.css');
const iconB64 = fs.readFileSync(path.join(root, 'icons/icon-192.png')).toString('base64');
const iconData = `data:image/png;base64,${iconB64}`;

// Codificador MP3 (script clásico, define window.lamejs).
const lame = R('js/vendor/lame.min.js');

// Extrae el contenido del <body> de index.html.
const html = R('index.html');
let body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
// Quita los <script src> (se incrustan) y usa el icono incrustado.
body = body.replace(/<script[^>]*src="js\/vendor\/lame\.min\.js"[^>]*><\/script>/, '');
body = body.replace(/<script[^>]*src="js\/app\.js"[^>]*><\/script>/, '');
body = body.split('icons/icon-192.png').join(iconData);

const content = `<style>\n${css}\n</style>\n${body}\n<script>\n${lame}\n</script>\n<script>\n${bundle}\n</script>\n`;

// Versión "contenido" para el Artifact (sin head/body).
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/artifact.html'), content);

// Versión autónoma para probar localmente y para descargar.
const standalone = `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1.0, user-scalable=no" />
<meta name="theme-color" content="#0d0d12" />
<link rel="icon" href="${iconData}" />
<link rel="apple-touch-icon" href="${iconData}" />
<title>PlayCUT — Editor de video en tu dispositivo</title>
</head><body>
${content}
</body></html>`;
fs.writeFileSync(path.join(root, 'dist/playcut.html'), standalone);

console.log('Bundle listo:', (content.length / 1024).toFixed(0) + ' KB');
