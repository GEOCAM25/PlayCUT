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

**Edición**
- 📱 **Interfaz estilo CapCut**, vertical y pensada para móvil (táctil).
- 🎞️ **Línea de tiempo** con pistas de **video/fotos**, **audio** y **texto/stickers**.
- ✂️ **Recortar** (trim), **dividir**, **duplicar**, **reordenar** y **borrar** clips.
- ↩️ **Deshacer / Rehacer** ilimitado dentro de la sesión.
- 🖼️ **Formatos de proyecto**: 9:16, 1:1, 16:9, 4:5, 3:4 y 21:9.

**Funciones Pro (como CapCut premium)**
- 🔀 **Transiciones reales** entre clips (con solapamiento): fundido, a negro,
  a blanco, deslizar (4 direcciones), zoom, barrido, desenfoque y giro — con
  duración ajustable.
- 🖼️ **Capa Overlay / Picture-in-Picture (PiP)**: superpone videos o fotos
  encima del principal, con posición y tamaño libres, esquinas redondeadas y
  sombra. Ideal para reacciones, collages y marcos.
- ⏱️ **Control de velocidad** por clip (0.25× a 4×), cámara lenta y rápida.
- ✦ **Movimiento Ken Burns**: zoom in/out y paneo sobre fotos y videos.
- 🎛️ **Transformación por clip**: escala, rotación, encuadre *Ajustar/Rellenar*
  y **fondo difuminado** automático para las barras.
- 🎨 **10 filtros**: Vívido, Cine, Cálido, Frío, Fade, Vintage, Noir, Neón, B/N…
- 🅣 **Texto avanzado**: 5 fuentes, color, fondo (pastilla), y **animaciones**
  de entrada/salida (fundido, pop, subir, bajar), posición y rotación.
- 😀 **Stickers** (emojis) con tamaño, posición y rotación.
- 🎵 **Audio y volumen completo**: volumen **independiente por clip** (sube el
  del video y baja el de la música, o al revés), **silenciar** clip, **fade in /
  fade out** ("aparecer/terminar poco a poco") y **"Aplicar a todos"** para
  igualar el volumen de todos los clips de una vez.
- 🔊 **Crossfade de audio** automático durante las transiciones.
- 🎨 **Color de fondo** del lienzo configurable.
- 🔍 **Zoom de la línea de tiempo** para editar con precisión.
- ↩️ **Deshacer / Rehacer**.

**Multi-dispositivo y rendimiento**
- 💻📱 **Diseño responsive**: en el teléfono, interfaz vertical táctil; en
  tablet, hojas centradas y más aire; en **PC**, layout de escritorio con
  vista previa grande y **panel lateral de herramientas**.
- ⚡ **Rendimiento adaptativo**: detecta las capacidades del equipo (núcleos,
  memoria, pantalla) y ajusta automáticamente la resolución y los fps de la
  vista previa para ir **siempre fluido**; modos *Automático / Alta / Ahorro*.
- ⌨️ **Atajos de teclado** en escritorio (Espacio, ← →, S, Supr, Ctrl+Z/Y, +/−).
- 👆 **Gestos intuitivos**: toca la vista previa para reproducir, arrastra hacia
  abajo una hoja para cerrarla, **imán (snapping)** al mover clips y **vibración
  háptica** en acciones clave.
- 🗂️ **Gestión de proyectos**: duplicar, borrar y ver el **uso de almacenamiento**
  del dispositivo.

**Exportar y guardar**
- 📤 **Exportación hasta 4K** (720p / 1080p / 2K / 4K) a **24/30/60 fps**,
  generada localmente en el dispositivo (canvas + Web Audio + MediaRecorder).
- ▶️ **Vista previa en tiempo real** sobre `<canvas>` (mismo motor que la exportación).
- 💾 **Guardado automático** de proyectos en el propio dispositivo.
- 🔒 **Privacidad total**: nada sale del dispositivo. No hay servidor.
- 📶 **PWA offline**: se puede **instalar** y usar **sin conexión**.

> **Nota sobre 4K:** la exportación es en tiempo real. El 4K/60fps requiere un
> teléfono con codificación H.264/HEVC por hardware (la mayoría de gama media-alta
> actual). Si el dispositivo no puede con la resolución elegida, la app lo detecta
> y sugiere bajar la calidad.

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

### Publicar en GitHub Pages (incluido)

El repo trae un workflow (`.github/workflows/deploy.yml`) que publica la app
automáticamente. **Solo hace falta activar Pages una vez** (GitHub no permite
que un workflow lo active solo, por seguridad):

1. Ve a **Settings → Pages** del repositorio.
2. En **Build and deployment → Source**, elige **GitHub Actions**.
3. Vuelve a **Actions → Deploy PlayCUT a GitHub Pages → Run workflow**
   (o haz cualquier push). El deploy terminará en verde.

La app quedará publicada en: **https://geocam25.github.io/PlayCUT/**
(rutas relativas, funciona bajo esa subruta y es instalable como PWA).

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
