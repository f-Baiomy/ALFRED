import { buildSnippetDoc } from './snippet-frame';
import { SnippetBridge } from './snippet-bridge';

describe('the picture Alfred keeps of a snippet', () => {
  it('is opaque on a theme whose card colour is see-through - Claude reads it on any background', async () => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.style.cssText = 'width:300px;height:120px';
    let bridge: SnippetBridge | null = null;
    const ready = new Promise<void>((r) => { bridge = new SnippetBridge(frame, async () => null, { ready: () => r() }); });
    frame.srcdoc = buildSnippetDoc({ source: '<p>hello</p>', origin: location.origin, inline: {}, vars: { '--card': 'rgba(255, 255, 255, .035)', '--popover-solid': '#161c4a' } });
    document.body.appendChild(frame);
    await ready;
    const png = await bridge!.shot(10000);
    const img = new Image();
    await new Promise((r) => { img.onload = r; img.src = png; });
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d')!; g.drawImage(img, 0, 0);
    const px = Array.from(g.getImageData(img.width - 5, img.height - 5, 1, 1).data);
    expect(px[3]).toBe(255); expect(px[0] + px[1] + px[2]).toBeLessThan(200);
  }, 30000);
});
