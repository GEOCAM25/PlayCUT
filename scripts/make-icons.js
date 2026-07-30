// Genera iconos PNG (192, 512 y maskable) sin dependencias externas.
// Dibuja un fondo con degradado morado->rosa y un botón "play" tipo CapCut.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function lerp(a, b, t) { return a + (b - a) * t; }

function makeIcon(size, maskable) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  const radius = maskable ? size : size * 0.235; // maskable: sin esquinas redondeadas
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Degradado diagonal morado -> rosa
      const t = (x + y) / (2 * size);
      const r = Math.round(lerp(124, 236, t));
      const g = Math.round(lerp(58, 72, t));
      const b = Math.round(lerp(237, 153, t));
      let alpha = 255;
      if (!maskable) {
        // esquinas redondeadas
        const rx = Math.max(radius - x, x - (size - radius), 0);
        const ry = Math.max(radius - y, y - (size - radius), 0);
        if (rx > 0 && ry > 0 && Math.hypot(rx, ry) > radius) alpha = 0;
      }
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = alpha;
    }
  }
  // Triángulo "play" blanco centrado
  const triW = size * 0.30;
  const triH = size * 0.34;
  const left = cx - triW * 0.35;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dy = y - cy;
      if (Math.abs(dy) > triH / 2) continue;
      const frac = (dy + triH / 2) / triH; // 0..1
      const rightEdge = left + triW * (1 - Math.abs(frac - 0.5) * 2);
      if (x >= left && x <= rightEdge) {
        const i = (y * size + x) * 4;
        rgba[i] = 255; rgba[i + 1] = 255; rgba[i + 2] = 255; rgba[i + 3] = 255;
      }
    }
  }
  return encodePNG(size, size, rgba);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.writeFileSync(path.join(outDir, 'icon-192.png'), makeIcon(192, false));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), makeIcon(512, false));
fs.writeFileSync(path.join(outDir, 'icon-maskable-512.png'), makeIcon(512, true));
console.log('Icons generated in', outDir);
