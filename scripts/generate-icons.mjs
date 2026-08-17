#!/usr/bin/env node
/**
 * Generates FrameScript's icon set.
 *
 * Hand-rolled PNG encoding (via node's zlib) rather than an image dependency:
 * the mark is a few filled rectangles, and a build-time image library would be
 * a large dependency for four small files.
 *
 * The mark: a film frame with sprocket perforations down the left edge and two
 * text rules inside — picture and script, which is the whole product.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const OUT_DIR = fileURLToPath(new URL('../src/assets/icons', import.meta.url));

const BG = [0x0b, 0x0c, 0x0e, 0xff];
const AMBER = [0xe0, 0xa3, 0x3e, 0xff];
const DIM = [0x8a, 0x65, 0x24, 0xff];

/** @param {number} size */
function renderIcon(size) {
  const pixels = new Uint8Array(size * size * 4);

  const setPixel = (x, y, color) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    pixels[i] = color[0];
    pixels[i + 1] = color[1];
    pixels[i + 2] = color[2];
    pixels[i + 3] = color[3];
  };

  const fillRect = (x0, y0, w, h, color) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) setPixel(x, y, color);
    }
  };

  fillRect(0, 0, size, size, BG);

  const u = size / 16; // design grid unit
  const px = (n) => Math.round(n * u);

  // Outer frame border.
  const border = Math.max(1, Math.round(u * 0.9));
  const fx = px(1.5);
  const fy = px(2);
  const fw = size - px(3);
  const fh = size - px(4);

  fillRect(fx, fy, fw, border, AMBER);
  fillRect(fx, fy + fh - border, fw, border, AMBER);
  fillRect(fx, fy, border, fh, AMBER);
  fillRect(fx + fw - border, fy, border, fh, AMBER);

  // Sprocket perforations down the left edge, outside the frame.
  const holeW = Math.max(1, Math.round(u * 0.8));
  const holeH = Math.max(1, Math.round(u * 1.1));
  for (let i = 0; i < 3; i++) {
    fillRect(px(0.3), fy + Math.round((fh / 3) * i + fh / 9), holeW, holeH, DIM);
  }

  // Two script rules inside the frame: a long line and a short one.
  const ruleH = Math.max(1, Math.round(u * 0.7));
  const insetX = fx + border + px(1.2);
  fillRect(insetX, fy + Math.round(fh * 0.36), Math.round(fw * 0.52), ruleH, AMBER);
  fillRect(insetX, fy + Math.round(fh * 0.58), Math.round(fw * 0.32), ruleH, DIM);

  return pixels;
}

/** Encodes RGBA pixels as a PNG buffer. */
function encodePng(pixels, size) {
  // Each scanline is prefixed with filter byte 0 (None).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(raw, rowStart + 1);
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData), 0);
    return Buffer.concat([length, typeAndData, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128, 512]) {
  const png = encodePng(renderIcon(size), size);
  writeFileSync(resolve(OUT_DIR, `icon-${size}.png`), png);
  console.log(`wrote icon-${size}.png (${png.length} bytes)`);
}
