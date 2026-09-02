// Rasterises src/assets/openclaw.svg into the PNGs electron-builder and the tray need.
//
// The outputs are COMMITTED to the repo on purpose: sharp is the only heavy native
// dependency here, and baking the PNGs in keeps `npm start` and the Windows build
// working on a clean clone without it. Re-run `npm run icons` only when the artwork
// changes. librsvg renders the SVG's initial SMIL frame, which is the pose we want.
import sharp from 'sharp';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const svg = readFileSync(path.join(root, 'src/assets/openclaw.svg'));

const outputs = [
  // electron-builder derives .icns and .ico from this; it requires >= 512px.
  { file: 'build/icon.png', size: 1024 },
  { file: 'src/assets/icon.png', size: 512 },
  { file: 'src/assets/tray.png', size: 16 },
  { file: 'src/assets/tray@2x.png', size: 32 },
];

mkdirSync(path.join(root, 'build'), { recursive: true });

for (const { file, size } of outputs) {
  const target = path.join(root, file);
  await sharp(svg, { density: Math.max(72, size) })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(target);
  console.log(`${file}  ${size}x${size}`);
}
