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

/**
 * Promote a plain {width, height, data} to a real ImageData.
 *
 * The core deals in the plain shape so it can run under Node, but canvas APIs
 * accept nothing else: putImageData throws on a look-alike object. Sheet
 * slicing produces the plain shape, so every canvas path has to come through
 * here.
 *
 * @param {ImageData | {width: number, height: number, data: Uint8ClampedArray|Uint8Array}} image
 * @returns {ImageData}
 */
export function toImageData(image) {
  if (typeof ImageData !== 'undefined' && image instanceof ImageData) return image;
  const data = image.data instanceof Uint8ClampedArray
    ? image.data
    : new Uint8ClampedArray(image.data);
  return new ImageData(data, image.width, image.height);
}
