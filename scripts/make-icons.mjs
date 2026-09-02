// Rasterises the icon artwork into the PNGs electron-builder and the tray need.
//
// Two sources, not one. src/assets/claw.svg is the application icon — a tile with
// a window and a title bar in it. src/assets/claw-tray.svg is the same mark with
// all of that removed, because at 16 physical pixels the frame and the title-bar
// dots turn to mush, and a filled dark square is the wrong shape to hang in a
// menu bar. Rendering one file at both sizes is what forces artwork to be timid
// at large sizes and illegible at small ones.
//
// The outputs are COMMITTED to the repo on purpose: sharp is the only heavy native
// dependency here, and baking the PNGs in keeps `npm start` and the Windows build
// working on a clean clone without it. Re-run `npm run icons` only when the
// artwork changes.
import sharp from 'sharp';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(path.join(root, p));

const app = read('src/assets/claw.svg');
const tray = read('src/assets/claw-tray.svg');

const outputs = [
  // electron-builder derives .icns and .ico from this; it requires >= 512px.
  { file: 'build/icon.png', size: 1024, svg: app },
  { file: 'src/assets/icon.png', size: 512, svg: app },
  { file: 'src/assets/tray.png', size: 16, svg: tray },
  { file: 'src/assets/tray@2x.png', size: 32, svg: tray },
];

mkdirSync(path.join(root, 'build'), { recursive: true });

for (const { file, size, svg } of outputs) {
  const target = path.join(root, file);
  // Rasterise at the final size rather than downsampling a large render: the
  // marks are shaped by their outline, and a 1024px render squeezed to 16px
  // loses the points at both ends of each one.
  await sharp(svg, { density: Math.max(72, size) })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(target);
  console.log(`${file}  ${size}x${size}`);
}
