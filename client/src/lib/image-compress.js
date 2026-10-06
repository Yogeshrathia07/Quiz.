/**
 * A picture for a question, made small before it is sent: its longest side
 * at most MAX_SIDE pixels, and its file under MAX_BYTES - a phone photo of
 * several megabytes becomes a couple of hundred kilobytes, which a weak phone
 * connection loads in a second or two. WebP where the browser can write it,
 * JPEG otherwise; turned the right way up from the camera's own note.
 */
const MAX_SIDE = 1600;
const MAX_BYTES = 500 * 1024;
const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/avif'];

const toBlob = (canvas, type, quality) => new Promise((resolve) => { canvas.toBlob(resolve, type, quality); });

/** The picture as something a canvas can draw, the right way up. */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall back below */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * `file` (from a file input) as `{ blob, width, height }`, ready to send. Throws
 * with a sentence the editor can show when it is not a picture, or too big
 * to work with.
 */
export async function compressImage(file) {
  if (!file || !TYPES.includes(file.type)) throw new Error('Choose a picture: JPEG, PNG, WebP or GIF.');
  if (file.size > MAX_INPUT_BYTES) throw new Error('That picture is over 25 MB. Choose a smaller one.');
  let source;
  try { source = await decode(file); } catch { throw new Error('That picture could not be opened. Try another.'); }
  const naturalWidth = source.width || source.naturalWidth;
  const naturalHeight = source.height || source.naturalHeight;
  let scale = Math.min(1, MAX_SIDE / Math.max(naturalWidth, naturalHeight));
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  // WebP if this browser can write it (an older Safari quietly writes PNG instead).
  const probe = await toBlob(Object.assign(document.createElement('canvas'), { width: 1, height: 1 }), 'image/webp', 0.8);
  const type = probe?.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
  for (let round = 0; round < 8; round += 1) {
    const width = Math.max(1, Math.round(naturalWidth * scale));
    const height = Math.max(1, Math.round(naturalHeight * scale));
    canvas.width = width;
    canvas.height = height;
    // A transparent PNG on white, not black, once it is a JPEG.
    context.fillStyle = '#FFFFFF';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, width, height);
    for (const quality of [0.85, 0.75, 0.65]) {
      const blob = await toBlob(canvas, type, quality);
      if (blob && blob.size <= MAX_BYTES) {
        source.close?.();
        return { blob, width, height };
      }
    }
    scale *= 0.8;
  }
  source.close?.();
  throw new Error('That picture could not be made small enough. Crop it and try again.');
}

/** "182 KB", "1.2 MB". */
export const sizeLabel = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
