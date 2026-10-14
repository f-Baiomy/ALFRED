import { AfterViewInit, Component, ElementRef, HostListener, input, output, signal, viewChild } from '@angular/core';

type Tool = 'box' | 'arrow' | 'label' | 'blur' | 'crop';

interface Mark {
  readonly tool: Exclude<Tool, 'crop'>;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly text?: string;
}

/**
 * Marks on a pasted screenshot (docs/board.md "Rich text"): a box, an arrow, a short label, a blur over personal data, a
 * crop - drawn on a canvas over the picture and saved as a new picture (the original is kept untouched). Nothing leaves
 * the page but the result, uploaded like any pasted picture.
 */
@Component({
  selector: 'app-image-annotate',
  standalone: true,
  template: `
    <div class="run-dialog-bg" (click)="closed.emit()">
      <div class="img-annot" role="dialog" aria-label="Mark the picture" (click)="$event.stopPropagation()">
        <div class="img-annot-bar">
          @for (t of tools; track t.id) {
            <button type="button" class="action-btn" [class.on]="tool() === t.id" [title]="t.title" (click)="tool.set(t.id)">{{ t.label }}</button>
          }
          <span class="img-annot-sep"></span>
          @for (c of colors; track c) {
            <button type="button" class="img-annot-color" [class.on]="color() === c" [style.background]="c" [title]="c" (click)="color.set(c)"></button>
          }
          <span class="img-annot-sep"></span>
          <button type="button" class="action-btn" [disabled]="!marks().length && !crop()" (click)="undo()">↶ Undo</button>
          <span class="img-annot-grow"></span>
          <button type="button" class="action-btn" (click)="closed.emit()">Cancel</button>
          <button type="button" class="action-btn primary" [disabled]="saving()" (click)="save()">{{ saving() ? 'Saving…' : 'Save' }}</button>
        </div>
        @if (tool() === 'label') { <div class="img-annot-hint">Click where the label goes, type it, Enter. <input #lbl class="board-var-input" [value]="labelText()" (input)="labelText.set(lbl.value)" placeholder="label" /></div> }
        @if (error()) { <div class="run-msg run-msg-err">{{ error() }}</div> }
        <div class="img-annot-stage">
          <canvas #canvas (mousedown)="down($event)" (mousemove)="move($event)" (mouseup)="up($event)" (mouseleave)="up($event)"></canvas>
        </div>
      </div>
    </div>`,
})
export class ImageAnnotateComponent implements AfterViewInit {
  readonly src = input.required<string>();
  /** The marked picture, as a PNG to upload. */
  readonly saved = output<Blob>();
  readonly closed = output<void>();

  readonly tools: readonly { id: Tool; label: string; title: string }[] = [
    { id: 'box', label: '▭ Box', title: 'Draw a box around something' }, { id: 'arrow', label: '➜ Arrow', title: 'Point at something' },
    { id: 'label', label: 'T Label', title: 'A short label' }, { id: 'blur', label: '▦ Blur', title: 'Hide personal data' },
    { id: 'crop', label: '⛶ Crop', title: 'Keep only a part' },
  ];
  readonly colors = ['#f87171', '#fbbf24', '#34d399', '#60a5fa', '#ffffff'];
  readonly tool = signal<Tool>('box');
  readonly color = signal('#f87171');
  readonly marks = signal<readonly Mark[]>([]);
  readonly crop = signal<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  readonly labelText = signal('');
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private img: HTMLImageElement | null = null;
  private start: { x: number; y: number } | null = null;
  private live: { x: number; y: number } | null = null;

  ngAfterViewInit(): void {
    const img = new Image();
    img.onload = () => {
      this.img = img;
      const c = this.canvas().nativeElement;
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      this.draw();
    };
    img.onerror = () => this.error.set('The picture could not be loaded');
    img.src = this.src();
  }

  private point(e: MouseEvent): { x: number; y: number } {
    const c = this.canvas().nativeElement;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  }

  down(e: MouseEvent): void {
    const p = this.point(e);
    if (this.tool() === 'label') {
      const text = this.labelText().trim() || 'here';
      this.marks.update((m) => [...m, { tool: 'label', x1: p.x, y1: p.y, x2: p.x, y2: p.y, text }]);
      this.draw();
      return;
    }
    this.start = p;
    this.live = p;
  }

  move(e: MouseEvent): void {
    if (!this.start) return;
    this.live = this.point(e);
    this.draw();
  }

  up(e: MouseEvent): void {
    if (!this.start) return;
    const end = this.point(e);
    const s = this.start;
    this.start = null;
    this.live = null;
    if (Math.abs(end.x - s.x) < 4 && Math.abs(end.y - s.y) < 4) { this.draw(); return; }
    const t = this.tool();
    if (t === 'crop') this.crop.set({ x1: s.x, y1: s.y, x2: end.x, y2: end.y });
    else if (t !== 'label') this.marks.update((m) => [...m, { tool: t, x1: s.x, y1: s.y, x2: end.x, y2: end.y }]);
    this.draw();
  }

  undo(): void {
    if (this.marks().length) this.marks.update((m) => m.slice(0, -1));
    else this.crop.set(null);
    this.draw();
  }

  @HostListener('document:keydown.escape')
  escape(): void {
    this.closed.emit();
  }

  private draw(): void {
    const c = this.canvas().nativeElement;
    const ctx = c.getContext('2d');
    if (!ctx || !this.img) return;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(this.img, 0, 0);
    const color = this.color();
    const all: Mark[] = [...this.marks()];
    if (this.start && this.live && this.tool() !== 'crop' && this.tool() !== 'label') {
      all.push({ tool: this.tool() as Mark['tool'], x1: this.start.x, y1: this.start.y, x2: this.live.x, y2: this.live.y });
    }
    const width = Math.max(3, Math.round(c.width / 300));
    for (const m of all) drawMark(ctx, m, color, width, this.img);
    const crop = this.start && this.live && this.tool() === 'crop' ? { x1: this.start.x, y1: this.start.y, x2: this.live.x, y2: this.live.y } : this.crop();
    if (crop) {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      const [x, y, w, h] = rect(crop);
      ctx.fillRect(0, 0, c.width, y);
      ctx.fillRect(0, y + h, c.width, c.height - y - h);
      ctx.fillRect(0, y, x, h);
      ctx.fillRect(x + w, y, c.width - x - w, h);
      ctx.setLineDash([8, 6]);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }
  }

  save(): void {
    if (!this.img) return;
    const crop = this.crop();
    const full = document.createElement('canvas');
    full.width = this.img.naturalWidth;
    full.height = this.img.naturalHeight;
    const fctx = full.getContext('2d')!;
    fctx.drawImage(this.img, 0, 0);
    const width = Math.max(3, Math.round(full.width / 300));
    for (const m of this.marks()) drawMark(fctx, m, this.color(), width, this.img);
    let out = full;
    if (crop) {
      const [x, y, w, h] = rect(crop);
      out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(w));
      out.height = Math.max(1, Math.round(h));
      out.getContext('2d')!.drawImage(full, x, y, w, h, 0, 0, out.width, out.height);
    }
    this.saving.set(true);
    out.toBlob((blob) => {
      this.saving.set(false);
      if (blob) this.saved.emit(blob); else this.error.set('The picture could not be saved');
    }, 'image/png');
  }
}

function rect(r: { x1: number; y1: number; x2: number; y2: number }): [number, number, number, number] {
  return [Math.min(r.x1, r.x2), Math.min(r.y1, r.y2), Math.abs(r.x2 - r.x1), Math.abs(r.y2 - r.y1)];
}

function drawMark(ctx: CanvasRenderingContext2D, m: Mark, color: string, width: number, img: HTMLImageElement): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  const [x, y, w, h] = rect(m);
  if (m.tool === 'box') {
    ctx.strokeRect(x, y, w, h);
  } else if (m.tool === 'blur') {
    // pixelate: draw the area tiny, then back up - unreadable, and the same on every save
    const block = Math.max(8, Math.round(Math.max(w, h) / 12));
    const tmp = document.createElement('canvas');
    tmp.width = Math.max(1, Math.round(w / block));
    tmp.height = Math.max(1, Math.round(h / block));
    const t = tmp.getContext('2d')!;
    t.drawImage(img, x, y, w, h, 0, 0, tmp.width, tmp.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h);
  } else if (m.tool === 'arrow') {
    const angle = Math.atan2(m.y2 - m.y1, m.x2 - m.x1);
    const head = width * 5;
    ctx.beginPath();
    ctx.moveTo(m.x1, m.y1);
    ctx.lineTo(m.x2, m.y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(m.x2, m.y2);
    ctx.lineTo(m.x2 - head * Math.cos(angle - Math.PI / 7), m.y2 - head * Math.sin(angle - Math.PI / 7));
    ctx.lineTo(m.x2 - head * Math.cos(angle + Math.PI / 7), m.y2 - head * Math.sin(angle + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
  } else if (m.tool === 'label' && m.text) {
    const size = Math.max(14, width * 6);
    ctx.font = `bold ${size}px system-ui, sans-serif`;
    const tw = ctx.measureText(m.text).width;
    ctx.fillRect(m.x1, m.y1 - size, tw + size * 0.6, size * 1.35);
    ctx.fillStyle = '#111';
    ctx.fillText(m.text, m.x1 + size * 0.3, m.y1 + size * 0.05);
  }
  ctx.restore();
}
