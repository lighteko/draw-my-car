import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

interface DecodedPng {
  width: number;
  height: number;
  data: Uint8Array;
}

interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function assertSignature(bytes: Uint8Array): void {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error("Expected a PNG image");
  }
}

function channelsForColorType(colorType: number): number {
  if (colorType === 0) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  throw new Error(`Unsupported PNG color type ${colorType}`);
}

function paeth(left: number, up: number, upperLeft: number): number {
  const p = left + up - upperLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upperLeft);
  if (pa <= pb && pa <= pc) return left;
  return pb <= pc ? up : upperLeft;
}

function unfilter(
  filtered: Uint8Array,
  width: number,
  height: number,
  bytesPerPixel: number,
): Uint8Array {
  const rowBytes = width * bytesPerPixel;
  const out = new Uint8Array(rowBytes * height);
  let inputOffset = 0;

  for (let y = 0; y < height; y++) {
    const filter = filtered[inputOffset++];
    const rowOffset = y * rowBytes;
    const prevRowOffset = rowOffset - rowBytes;

    for (let x = 0; x < rowBytes; x++) {
      const raw = filtered[inputOffset++];
      const left = x >= bytesPerPixel ? out[rowOffset + x - bytesPerPixel] : 0;
      const up = y > 0 ? out[prevRowOffset + x] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel ? out[prevRowOffset + x - bytesPerPixel] : 0;

      if (filter === 0) out[rowOffset + x] = raw;
      else if (filter === 1) out[rowOffset + x] = (raw + left) & 0xff;
      else if (filter === 2) out[rowOffset + x] = (raw + up) & 0xff;
      else if (filter === 3) out[rowOffset + x] = (raw + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) out[rowOffset + x] = (raw + paeth(left, up, upperLeft)) & 0xff;
      else throw new Error(`Unsupported PNG filter ${filter}`);
    }
  }

  return out;
}

function toRgba(decoded: Uint8Array, colorType: number, width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  const channels = channelsForColorType(colorType);

  for (let i = 0, j = 0; i < decoded.length; i += channels, j += 4) {
    if (colorType === 0) {
      rgba[j] = decoded[i];
      rgba[j + 1] = decoded[i];
      rgba[j + 2] = decoded[i];
      rgba[j + 3] = 255;
    } else if (colorType === 2) {
      rgba[j] = decoded[i];
      rgba[j + 1] = decoded[i + 1];
      rgba[j + 2] = decoded[i + 2];
      rgba[j + 3] = 255;
    } else if (colorType === 4) {
      rgba[j] = decoded[i];
      rgba[j + 1] = decoded[i];
      rgba[j + 2] = decoded[i];
      rgba[j + 3] = decoded[i + 1];
    } else {
      rgba[j] = decoded[i];
      rgba[j + 1] = decoded[i + 1];
      rgba[j + 2] = decoded[i + 2];
      rgba[j + 3] = decoded[i + 3];
    }
  }

  return rgba;
}

function decodePng(bytes: Uint8Array): DecodedPng {
  assertSignature(bytes);

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Uint8Array[] = [];

  while (offset < bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    offset += 4;
    const type = Buffer.from(bytes.subarray(offset, offset + 4)).toString("ascii");
    offset += 4;
    const data = bytes.subarray(offset, offset + length);
    offset += length + 4;

    if (type === "IHDR") {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = view.getUint32(0);
      height = view.getUint32(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (!width || !height) throw new Error("PNG is missing IHDR");
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error("Interlaced PNGs are not supported");

  const compressed = Buffer.concat(idat.map((chunk) => Buffer.from(chunk)));
  const filtered = new Uint8Array(inflateSync(compressed));
  const channels = channelsForColorType(colorType);
  const decoded = unfilter(filtered, width, height, channels);

  return { width, height, data: toRgba(decoded, colorType, width, height) };
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBytes.copy(out, 4);
  Buffer.from(data).copy(out, 8);
  const crcInput = Buffer.concat([typeBytes, Buffer.from(data)]);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}

function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const rawOffset = y * (rowBytes + 1);
    raw[rawOffset] = 0;
    Buffer.from(rgba.subarray(y * rowBytes, (y + 1) * rowBytes)).copy(raw, rawOffset + 1);
  }

  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}

export function cropPng(bytes: Uint8Array, rect: CropRect): Uint8Array {
  const source = decodePng(bytes);
  const x = Math.max(0, Math.min(source.width - 1, Math.floor(rect.x)));
  const y = Math.max(0, Math.min(source.height - 1, Math.floor(rect.y)));
  const width = Math.max(1, Math.min(source.width - x, Math.floor(rect.width)));
  const height = Math.max(1, Math.min(source.height - y, Math.floor(rect.height)));
  const cropped = new Uint8Array(width * height * 4);

  for (let row = 0; row < height; row++) {
    const from = ((y + row) * source.width + x) * 4;
    const to = row * width * 4;
    cropped.set(source.data.subarray(from, from + width * 4), to);
  }

  return encodePng(width, height, cropped);
}

export function splitPngGrid2x2(
  bytes: Uint8Array,
  insetRatio: number = 0.12,
): [Uint8Array, Uint8Array, Uint8Array, Uint8Array] {
  const source = decodePng(bytes);
  const cellWidth = Math.floor(source.width / 2);
  const cellHeight = Math.floor(source.height / 2);
  const insetX = Math.max(0, Math.floor(cellWidth * insetRatio));
  const insetY = Math.max(0, Math.floor(cellHeight * insetRatio));
  const innerWidth = Math.max(1, cellWidth - insetX * 2);
  const innerHeight = Math.max(1, cellHeight - insetY * 2);
  return [
    cropPng(bytes, { x: insetX, y: insetY, width: innerWidth, height: innerHeight }),
    cropPng(bytes, {
      x: cellWidth + insetX,
      y: insetY,
      width: Math.max(1, source.width - cellWidth - insetX * 2),
      height: innerHeight,
    }),
    cropPng(bytes, {
      x: insetX,
      y: cellHeight + insetY,
      width: innerWidth,
      height: Math.max(1, source.height - cellHeight - insetY * 2),
    }),
    cropPng(bytes, {
      x: cellWidth + insetX,
      y: cellHeight + insetY,
      width: Math.max(1, source.width - cellWidth - insetX * 2),
      height: Math.max(1, source.height - cellHeight - insetY * 2),
    }),
  ];
}
