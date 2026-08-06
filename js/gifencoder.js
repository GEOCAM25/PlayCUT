// gifencoder.js — Codificador GIF89a animado, 100% en el dispositivo.
// Paleta fija de 216 colores (cubo RGB 6×6×6) y compresión LZW estándar.
// Basado en el clásico LZWEncoder (as3gif / jsgif, MIT).

// Paleta global: cubo 6×6×6 = 216 colores, resto en negro (256 entradas).
const PALETTE = (() => {
  const p = new Uint8Array(768);
  let i = 0;
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) {
    p[i++] = Math.round(r * 255 / 5);
    p[i++] = Math.round(g * 255 / 5);
    p[i++] = Math.round(b * 255 / 5);
  }
  return p;
})();

function quantize(rgba, n) {
  const out = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = Math.round(rgba[j] / 255 * 5);
    const g = Math.round(rgba[j + 1] / 255 * 5);
    const b = Math.round(rgba[j + 2] / 255 * 5);
    out[i] = r * 36 + g * 6 + b;
  }
  return out;
}

class ByteWriter {
  constructor() { this.a = []; }
  byte(b) { this.a.push(b & 0xff); }
  short(s) { this.a.push(s & 0xff, (s >> 8) & 0xff); }
  str(s) { for (let i = 0; i < s.length; i++) this.a.push(s.charCodeAt(i)); }
  bytes(arr) { for (let i = 0; i < arr.length; i++) this.a.push(arr[i]); }
  toU8() { return new Uint8Array(this.a); }
}

// LZW de GIF sobre índices de píxel (colorDepth bits). Escribe en `out`.
function lzwEncode(width, height, pixels, colorDepth, out) {
  const EOF = -1;
  const initCodeSize = Math.max(2, colorDepth);
  const BITS = 12, HSIZE = 5003, maxmaxcode = 1 << BITS;
  const htab = new Int32Array(HSIZE);
  const codetab = new Int32Array(HSIZE);
  const masks = [0x0000, 0x0001, 0x0003, 0x0007, 0x000F, 0x001F, 0x003F, 0x007F, 0x00FF, 0x01FF, 0x03FF, 0x07FF, 0x0FFF];
  let n_bits, maxcode, free_ent = 0, clear_flg = false, g_init_bits, ClearCode, EOFCode;
  let cur_accum = 0, cur_bits = 0;
  const accum = new Uint8Array(256); let a_count = 0;
  let remaining = width * height, curPixel = 0;

  const MAXCODE = (n) => (1 << n) - 1;
  const nextPixel = () => { if (remaining === 0) return EOF; remaining--; return pixels[curPixel++] & 0xff; };
  const flush_char = () => { if (a_count > 0) { out.byte(a_count); for (let i = 0; i < a_count; i++) out.byte(accum[i]); a_count = 0; } };
  const char_out = (c) => { accum[a_count++] = c; if (a_count >= 254) flush_char(); };
  const cl_hash = (hs) => { for (let i = 0; i < hs; i++) htab[i] = -1; };

  const output = (code) => {
    cur_accum &= masks[cur_bits];
    if (cur_bits > 0) cur_accum |= (code << cur_bits); else cur_accum = code;
    cur_bits += n_bits;
    while (cur_bits >= 8) { char_out(cur_accum & 0xff); cur_accum >>= 8; cur_bits -= 8; }
    if (free_ent > maxcode || clear_flg) {
      if (clear_flg) { maxcode = MAXCODE(n_bits = g_init_bits); clear_flg = false; }
      else { n_bits++; maxcode = (n_bits === BITS) ? maxmaxcode : MAXCODE(n_bits); }
    }
    if (code === EOFCode) {
      while (cur_bits > 0) { char_out(cur_accum & 0xff); cur_accum >>= 8; cur_bits -= 8; }
      flush_char();
    }
  };
  const cl_block = () => { cl_hash(HSIZE); free_ent = ClearCode + 2; clear_flg = true; output(ClearCode); };

  out.byte(initCodeSize);
  g_init_bits = initCodeSize + 1;
  n_bits = g_init_bits; maxcode = MAXCODE(n_bits);
  ClearCode = 1 << (initCodeSize); EOFCode = ClearCode + 1; free_ent = ClearCode + 2;
  a_count = 0;
  let ent = nextPixel();
  let hshift = 0;
  for (let fcode = HSIZE; fcode < 65536; fcode *= 2) hshift++;
  hshift = 8 - hshift;
  cl_hash(HSIZE);
  output(ClearCode);
  let c;
  outer: while ((c = nextPixel()) !== EOF) {
    const fcode = (c << BITS) + ent;
    let i = (c << hshift) ^ ent;
    if (htab[i] === fcode) { ent = codetab[i]; continue; }
    else if (htab[i] >= 0) {
      let disp = HSIZE - i; if (i === 0) disp = 1;
      do { if ((i -= disp) < 0) i += HSIZE; if (htab[i] === fcode) { ent = codetab[i]; continue outer; } } while (htab[i] >= 0);
    }
    output(ent); ent = c;
    if (free_ent < maxmaxcode) { codetab[i] = free_ent++; htab[i] = fcode; }
    else cl_block();
  }
  output(ent); output(EOFCode);
  out.byte(0); // fin de los sub-bloques de imagen
}

// frames: array de Uint8ClampedArray/Uint8Array RGBA (width*height*4).
// delayCs: retardo entre fotogramas en centésimas de segundo.
export function encodeGif(frames, width, height, delayCs, { loop = 0 } = {}) {
  const out = new ByteWriter();
  out.str('GIF89a');
  out.short(width); out.short(height);
  out.byte(0xF7); out.byte(0); out.byte(0); // GCT 256 colores, 8 bits
  out.bytes(PALETTE);
  // Extensión de bucle (Netscape)
  out.byte(0x21); out.byte(0xFF); out.byte(11); out.str('NETSCAPE2.0');
  out.byte(3); out.byte(1); out.short(loop); out.byte(0);
  const n = width * height;
  for (const rgba of frames) {
    const indexed = quantize(rgba, n);
    out.byte(0x21); out.byte(0xF9); out.byte(4); out.byte(0);
    out.short(delayCs); out.byte(0); out.byte(0); // sin transparencia
    out.byte(0x2C); out.short(0); out.short(0); out.short(width); out.short(height); out.byte(0);
    lzwEncode(width, height, indexed, 8, out);
  }
  out.byte(0x3B); // fin del archivo
  return new Blob([out.toU8()], { type: 'image/gif' });
}
