import { captureScrolls, restoreScrolls } from './return-point.service';

describe('return point scrolls', () => {
  let box: HTMLElement;

  beforeEach(() => {
    box = document.createElement('div');
    box.className = 'rp-test-scroller';
    box.style.cssText = 'height:100px;overflow:auto';
    box.innerHTML = '<div style="height:1000px"></div>';
    document.body.appendChild(box);
  });

  afterEach(() => box.remove());

  it('records only what is scrolled, and puts it back once the element is there and tall enough', async () => {
    expect(captureScrolls(['.rp-test-scroller'], false)).toEqual([]);
    box.scrollTop = 250;
    const marks = captureScrolls(['.rp-test-scroller'], false);
    expect(marks).toEqual([{ selector: '.rp-test-scroller', index: 0, top: 250, left: 0 }]);

    // the page re-renders: the element comes back short, then grows
    box.remove();
    box = document.createElement('div');
    box.className = 'rp-test-scroller';
    box.style.cssText = 'height:100px;overflow:auto';
    box.innerHTML = '<div style="height:10px"></div>';
    document.body.appendChild(box);
    const restoring = restoreScrolls(marks);
    setTimeout(() => (box.innerHTML = '<div style="height:1000px"></div>'), 120);
    await restoring;
    expect(box.scrollTop).toBe(250);
  });
});
