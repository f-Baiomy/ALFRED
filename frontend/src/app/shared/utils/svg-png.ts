/**
 * A drawn board visual (an SVG the board built itself) as a PNG: serialized, drawn on a canvas at 2× for sharpness,
 * downloaded (specs/017 R35). Every colour is an attribute on the SVG, so the picture looks the same outside the page.
 */
export function svgToPngBlob(svg: SVGSVGElement, background = '#0b1030', scale = 2): Promise<Blob> {
  const box = svg.viewBox.baseVal;
  const width = box && box.width ? box.width : svg.clientWidth || 640;
  const height = box && box.height ? box.height : svg.clientHeight || 300;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  const xml = new XMLSerializer().serializeToString(clone);
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('No canvas')); return; }
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be made'))), 'image/png');
    };
    img.onerror = () => reject(new Error('The picture could not be made'));
    img.src = url;
  });
}

export function downloadBlobAs(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** A file name from a title: letters, digits and dashes. */
export function fileNameOf(title: string, ext: string): string {
  const base = title.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'visual';
  return `${base}.${ext}`;
}
