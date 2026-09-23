// @ts-check
/**
 * Browser PNG decoding.
 *
 * Kept out of core/views.js so the carve has no DOM dependency at all: Node
 * has its own decoder in mcp/png.js, and both hand the core the same plain
 * {width, height, data} shape.
 */

/**
 * Decode a File/Blob into ImageData with no smoothing anywhere along the path.
 * @param {Blob} blob
 * @returns {Promise<ImageData>}
 */
export async function decodeImage(blob) {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
