// ── Render Hugh's tab icons from the Orb's geometry ─────────────────────────
//
// Writes app/icon1.svg (most browsers) and app/icon2.png (a 512px copy for
// browsers that will not show an SVG icon). Next numbers the files so it
// links both. Run after changing lib/brand/orb.ts:
//
//     npm run brand:icon
//
// lib/brand/orb.test.ts fails while app/icon1.svg is out of date.

import fs from "fs";
import path from "path";
import sharp from "sharp";
import { orbIconSvg } from "../lib/brand/orb";

const PNG_SIZE = 512;
const APP_DIR = path.join(__dirname, "..", "app");

async function main(): Promise<void> {
  const svg = orbIconSvg();
  const svgPath = path.join(APP_DIR, "icon1.svg");
  const pngPath = path.join(APP_DIR, "icon2.png");

  fs.writeFileSync(svgPath, svg);

  // sharp rasterises an SVG at 72 dpi by default, which for a 68-unit viewBox
  // is a 68px image. Raise the density so it renders at full size rather than
  // being upscaled (and blurred) by the resize.
  const viewBoxWidth = Number(svg.match(/viewBox="[\d.]+ [\d.]+ ([\d.]+)/)?.[1]);
  if (!Number.isFinite(viewBoxWidth) || viewBoxWidth <= 0) {
    throw new Error("Could not read the icon's viewBox width");
  }
  await sharp(Buffer.from(svg), { density: (72 * PNG_SIZE) / viewBoxWidth })
    .resize(PNG_SIZE, PNG_SIZE)
    .png()
    .toFile(pngPath);

  console.log(`Wrote ${path.relative(process.cwd(), svgPath)} and ${path.relative(process.cwd(), pngPath)}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
