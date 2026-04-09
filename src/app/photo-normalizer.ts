export interface NormalizedPhotoBlob {
  blob: Blob;
  fileName: string;
  wasHeicConverted: boolean;
}

interface NormalizePhotoOptions {
  optimize?: boolean;
}

export function looksLikeImageFile(fileName: string, mimeType: string): boolean {
  if (mimeType.startsWith('image/')) {
    return true;
  }

  return /\.(avif|bmp|gif|heic|heif|jpeg|jpg|png|svg|webp)$/i.test(fileName);
}

export function isHeicLikeFile(fileName: string, mimeType: string): boolean {
  return /(\.heic|\.heif)$/i.test(fileName) || /image\/hei(c|f)/i.test(mimeType);
}

export async function normalizePhotoBlob(
  blob: Blob,
  fileName: string,
  options: NormalizePhotoOptions = {}
): Promise<NormalizedPhotoBlob> {
  let normalizedBlob = blob;
  let normalizedFileName = fileName;
  let wasHeicConverted = false;

  if (!isHeicLikeFile(fileName, blob.type)) {
    normalizedBlob = blob;
    normalizedFileName = fileName;
  } else {
    normalizedBlob = await convertHeicBlob(blob);
    normalizedFileName = replaceFileExtension(fileName, 'jpg');
    wasHeicConverted = true;
  }

  const shouldOptimize = options.optimize ?? true;

  if (!shouldOptimize) {
    return {
      blob: normalizedBlob,
      fileName: normalizedFileName,
      wasHeicConverted
    };
  }

  const optimizedPhoto = await safelyOptimizeGalleryPhoto(normalizedBlob, normalizedFileName);

  return {
    blob: optimizedPhoto.blob,
    fileName: optimizedPhoto.fileName,
    wasHeicConverted
  };
}

function replaceFileExtension(fileName: string, nextExtension: string): string {
  const baseName = fileName.replace(/\.[^.]+$/, '');
  return `${baseName}.${nextExtension}`;
}

async function convertHeicBlob(blob: Blob): Promise<Blob> {
  try {
    // Lazy-load HEIC conversion code so normal gallery browsing has a smaller initial bundle.
    const { heicTo } = await import('heic-to');
    const convertedBlob = await heicTo({
      blob,
      type: 'image/jpeg',
      quality: 0.92
    });

    return ensureJpegBlob(convertedBlob);
  } catch (libraryError) {
    try {
      return await rasterizeImageBlob(blob, 'image/jpeg', 0.92);
    } catch {
      const reason = libraryError instanceof Error
        ? libraryError.message
        : 'The HEIC decoder could not read this file.';

      throw new Error(
        `This HEIC photo could not be converted in the browser. ${reason} Try exporting it as JPG from the iPhone Photos app if this same file keeps failing.`
      );
    }
  }
}

function ensureJpegBlob(blob: Blob): Blob {
  if (blob.type === 'image/jpeg') {
    return blob;
  }

  return new Blob([blob], { type: 'image/jpeg' });
}

async function optimizeGalleryPhoto(
  blob: Blob,
  fileName: string
): Promise<{ blob: Blob; fileName: string }> {
  if (!canOptimizeRasterImage(blob, fileName)) {
    return { blob, fileName };
  }

  if (blob.size <= 2_000_000) {
    return { blob, fileName };
  }

  const imageSource = await loadRasterImage(blob);

  try {
    const longestEdge = Math.max(imageSource.width, imageSource.height);

    if (longestEdge <= 2200 && blob.size <= 2_800_000) {
      return { blob, fileName };
    }

    const scale = Math.min(1, 2200 / longestEdge);
    const targetWidth = Math.max(1, Math.round(imageSource.width * scale));
    const targetHeight = Math.max(1, Math.round(imageSource.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const context = canvas.getContext('2d');

    if (!context) {
      return { blob, fileName };
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(imageSource, 0, 0, targetWidth, targetHeight);

    const optimizedBlob = await canvasToBlob(canvas, 'image/jpeg', 0.88);

    if (optimizedBlob.size >= blob.size && longestEdge <= 3000) {
      return { blob, fileName };
    }

    return {
      blob: optimizedBlob,
      fileName: replaceFileExtension(fileName, 'jpg')
    };
  } finally {
    if (typeof ImageBitmap !== 'undefined' && imageSource instanceof ImageBitmap) {
      imageSource.close();
    }
  }
}

function canOptimizeRasterImage(blob: Blob, fileName: string): boolean {
  if (/\.svg$/i.test(fileName) || blob.type === 'image/svg+xml') {
    return false;
  }

  if (/\.gif$/i.test(fileName) || blob.type === 'image/gif') {
    return false;
  }

  return looksLikeImageFile(fileName, blob.type);
}

async function loadRasterImage(blob: Blob): Promise<CanvasImageSource & { width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      return loadImageElement(blob);
    }
  }

  return loadImageElement(blob);
}

async function rasterizeImageBlob(blob: Blob, type: string, quality: number): Promise<Blob> {
  const imageSource = await loadRasterImage(blob);

  try {
    const canvas = document.createElement('canvas');
    canvas.width = imageSource.width;
    canvas.height = imageSource.height;

    const context = canvas.getContext('2d');

    if (!context) {
      throw new Error('Could not create an image canvas.');
    }

    context.drawImage(imageSource, 0, 0, imageSource.width, imageSource.height);
    return await canvasToBlob(canvas, type, quality);
  } finally {
    if (typeof ImageBitmap !== 'undefined' && imageSource instanceof ImageBitmap) {
      imageSource.close();
    }
  }
}

async function loadImageElement(blob: Blob): Promise<HTMLImageElement> {
  const objectUrl = URL.createObjectURL(blob);

  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Could not decode the image.'));
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) {
        resolve(result);
        return;
      }

      reject(new Error('Could not export the optimized image.'));
    }, type, quality);
  });
}

async function safelyOptimizeGalleryPhoto(
  blob: Blob,
  fileName: string
): Promise<{ blob: Blob; fileName: string }> {
  try {
    return await optimizeGalleryPhoto(blob, fileName);
  } catch {
    return { blob, fileName };
  }
}
