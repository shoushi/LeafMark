import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NtExecutable, NtExecutableResource } from '../node_modules/.pnpm/pe-library@0.4.1/node_modules/pe-library/dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exePath = path.resolve(process.argv[2] ?? path.join(root, 'release', 'win-unpacked', 'LeafMark.exe'));
const icoPath = path.resolve(process.argv[3] ?? path.join(root, 'build', 'icon.ico'));

function asArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function readIco(filePath) {
  const ico = fs.readFileSync(filePath);
  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) {
    throw new Error(`Not an icon file: ${filePath}`);
  }

  const count = ico.readUInt16LE(4);
  if (count < 1) throw new Error(`Icon file has no images: ${filePath}`);

  const images = [];
  for (let index = 0; index < count; index += 1) {
    const entryOffset = 6 + index * 16;
    const width = ico[entryOffset] || 256;
    const height = ico[entryOffset + 1] || 256;
    const colorCount = ico[entryOffset + 2];
    const planes = ico.readUInt16LE(entryOffset + 4) || 1;
    const bitCount = ico.readUInt16LE(entryOffset + 6) || 32;
    const byteLength = ico.readUInt32LE(entryOffset + 8);
    const imageOffset = ico.readUInt32LE(entryOffset + 12);
    const image = ico.subarray(imageOffset, imageOffset + byteLength);
    if (image.byteLength !== byteLength) throw new Error(`Invalid icon image ${index}`);
    images.push({ width, height, colorCount, planes, bitCount, bin: asArrayBuffer(image) });
  }
  return images;
}

function makeGroupIcon(images) {
  const group = Buffer.alloc(6 + images.length * 14);
  group.writeUInt16LE(0, 0);
  group.writeUInt16LE(1, 2);
  group.writeUInt16LE(images.length, 4);
  images.forEach((image, index) => {
    const offset = 6 + index * 14;
    group[offset] = image.width === 256 ? 0 : image.width;
    group[offset + 1] = image.height === 256 ? 0 : image.height;
    group[offset + 2] = image.colorCount;
    group[offset + 3] = 0;
    group.writeUInt16LE(image.planes, offset + 4);
    group.writeUInt16LE(image.bitCount, offset + 6);
    group.writeUInt32LE(image.bin.byteLength, offset + 8);
    group.writeUInt16LE(index + 1, offset + 12);
  });
  return asArrayBuffer(group);
}

const images = readIco(icoPath);
const executable = NtExecutable.from(fs.readFileSync(exePath));
const resources = NtExecutableResource.from(executable, true);
const existingGroup = resources.entries.find((entry) => entry.type === 14 && entry.id === 1);
const language = existingGroup?.lang ?? resources.entries.find((entry) => entry.type === 3)?.lang ?? 1033;

resources.entries = resources.entries.filter((entry) => entry.type !== 3 && entry.type !== 14);
images.forEach((image, index) => {
  resources.replaceResourceEntry({
    type: 3,
    id: index + 1,
    lang: language,
    codepage: 0,
    bin: image.bin,
  });
});
resources.replaceResourceEntry({
  type: 14,
  id: 1,
  lang: language,
  codepage: 0,
  bin: makeGroupIcon(images),
});
resources.outputResource(executable);
fs.writeFileSync(exePath, Buffer.from(executable.generate()));

console.log(`Embedded ${images.length} icon images into ${exePath}`);
