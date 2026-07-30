# 🎬 PlayCUT

**Editor de video estilo CapCut que funciona 100% en tu dispositivo.**
Sin nube. Sin cuentas. Sin subir nada a internet.

Cada persona instala la app en su propio teléfono y **todo su contenido
(videos, fotos, música y proyectos) se guarda únicamente en ese dispositivo**,
usando el almacenamiento local del navegador (IndexedDB). Funciona igual para
cada usuario, de forma independiente y privada.

![PlayCUT](icons/icon-192.png)

---

## ✨ Características

- 📱 **Interfaz estilo CapCut**, vertical y pensada para móvil (táctil).
- 🎞️ **Línea de tiempo** con pistas de **video/fotos**, **audio** y **texto**.
- ✂️ **Recortar** (trim), **dividir**, **duplicar**, **reordenar** y **borrar** clips.
- 🅣 **Texto** superpuesto con tamaño, color y posición.
- 🎛️ **Ajustes por clip**: volumen, brillo, contraste, saturación, opacidad.
- 🎨 **Filtros**: Original, B/N, Cálido, Frío, Vívido, Vintage.
- 🎵 **Música/audio** con volumen independiente y posición libre en el tiempo.
- ▶️ **Vista previa en tiempo real** sobre `<canvas>`.
- 💾 **Guardado automático** de proyectos en el propio dispositivo.
- 📤 **Exportación de video** generada localmente (MediaRecorder), lista para
  descargar o compartir desde el teléfono.
- 🔒 **Privacidad total**: nada sale del dispositivo. No hay servidor.
- 📶 **PWA offline**: se puede **instalar** y usar **sin conexión**.

---

## 🚀 Cómo usarla

Como es una PWA, necesita servirse por HTTP(S) (los Service Workers y la
instalación requieren `https://` o `localhost`). Basta con servir la carpeta:

### Opción rápida (local)

```bash
# con Node
npx http-server . -p 8080 -c-1
# o con Python
python3 -m http.server 8080
```

Luego abre `http://localhost:8080` en el navegador.

### En el teléfono (recomendado)

1. Publica la carpeta en cualquier hosting estático con HTTPS
   (por ejemplo **GitHub Pages**, Netlify, Vercel o tu propio servidor).
2. Abre la URL en el navegador del teléfono (Chrome/Edge en Android,
   Safari en iOS).
3. Usa **«Añadir a pantalla de inicio» / «Instalar app»**.
4. Ábrela desde el icono como una app normal. A partir de ahí funciona
   **offline** y **todo tu contenido queda en ese teléfono**.

> **GitHub Pages:** activa Pages en `Settings → Pages` apuntando a la rama y
> carpeta raíz. La app usa rutas relativas, así que funciona bajo cualquier
> subruta (`https://usuario.github.io/PlayCUT/`).

---

## 🧠 ¿Dónde se guardan mis cosas?

- Los **archivos importados** (video, foto, audio) se guardan como *blobs* en
  **IndexedDB**, dentro del navegador de tu dispositivo.
- Los **proyectos** (clips, cortes, textos, ajustes) también se guardan en
  IndexedDB.
- El **Service Worker** solo cachea los archivos de la propia app para poder
  abrirla sin internet — **no** guarda ahí tu contenido.

Nada de esto se transmite a ningún servidor. Si borras los datos del navegador
o desinstalas la PWA, se borran también los proyectos de ese dispositivo.

---

## 🏗️ Arquitectura

```
index.html            Estructura de la interfaz (Home + Editor + hojas)
css/styles.css        Estilos (tema oscuro tipo CapCut, mobile-first)
js/
  app.js              Controlador principal (navegación, acciones, UI)
  state.js            Modelo de datos del proyecto y utilidades
  db.js               Persistencia local con IndexedDB
  media.js            Importación, miniaturas y grafo de Web Audio
  engine.js           Motor de reproducción y render sobre <canvas>
  timeline.js         Render e interacción táctil de la línea de tiempo
  exporter.js         Exportación de video (canvas + audio → MediaRecorder)
manifest.webmanifest  Manifiesto PWA (instalable)
sw.js                 Service Worker (funcionamiento offline)
icons/                Iconos de la app
scripts/make-icons.js Generador de iconos PNG (sin dependencias)
```

### Cómo funciona la exportación

La vista previa y la exportación comparten el **mismo motor de render**. Al
exportar, el `<canvas>` se captura con `canvas.captureStream()` y el audio se
mezcla con la **Web Audio API** hacia un `MediaStreamDestination`. Ambos flujos
se combinan y se graban con `MediaRecorder`, reproduciendo la línea de tiempo
completa en tiempo real. El resultado es un archivo de video (`.mp4` o `.webm`
según lo que soporte el navegador) que se descarga en el propio dispositivo.

---

## ⚙️ Compatibilidad

| Función | Estado |
|---|---|
| Chrome / Edge (Android, escritorio) | ✅ Recomendado (mejor soporte de MediaRecorder) |
| Safari (iOS 16+) | ✅ Funciona; el formato de exportación puede ser distinto |
| Firefox | ✅ Edición y exportación a WebM |

> La exportación es en **tiempo real**: un video de 1 minuto tarda ~1 minuto.
> Mantén la pantalla encendida durante el proceso.

---

## 🛠️ Desarrollo

Regenerar los iconos:

```bash
node scripts/make-icons.js
```

No hay paso de compilación: es JavaScript modular estándar (ES Modules) que
corre directamente en el navegador.

---

## 🔐 Privacidad

PlayCUT no incluye analítica, ni telemetría, ni peticiones a terceros. Todo el
procesamiento de video ocurre en el dispositivo. Es tuyo y solo tuyo.
