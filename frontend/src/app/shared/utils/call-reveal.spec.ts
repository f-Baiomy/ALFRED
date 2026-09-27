import { fakeAsync, tick } from '@angular/core/testing';
import { findCallRow, pointAtCall } from './call-reveal';

describe('pointAtCall', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    host.innerHTML = `
      <div class="call-row" id="call-row-a">A</div>
      <div data-call-row="b">B</div>
    `;
    document.body.appendChild(host);
  });

  afterEach(() => host.remove());

  it('finds a call in either the list or the waterfall markup', () => {
    expect(findCallRow(host, 'a')?.textContent).toContain('A');
    expect(findCallRow(host, 'b')?.textContent).toContain('B');
    expect(findCallRow(host, 'missing')).toBeNull();
  });

  it('tags and outlines the call, and clears on the next click after it settles', fakeAsync(() => {
    const row = findCallRow(host, 'a')!;
    spyOn(row, 'scrollIntoView');
    pointAtCall(row);
    expect(row.scrollIntoView).toHaveBeenCalled();
    expect(row.classList).toContain('call-reveal');
    expect(row.querySelector('.call-reveal-tag')?.textContent).toBe('This call');

    // A click while it is still settling doesn't count.
    document.dispatchEvent(new Event('pointerdown'));
    expect(row.classList).toContain('call-reveal');

    tick(2700);
    document.dispatchEvent(new Event('pointerdown'));
    expect(row.classList).not.toContain('call-reveal');
    expect(row.querySelector('.call-reveal-tag')).toBeNull();
  }));

  it('only ever points at one call', () => {
    const a = findCallRow(host, 'a')!;
    const b = findCallRow(host, 'b')!;
    spyOn(a, 'scrollIntoView');
    spyOn(b, 'scrollIntoView');
    pointAtCall(a);
    pointAtCall(b);
    expect(a.classList).not.toContain('call-reveal');
    expect(b.classList).toContain('call-reveal');
  });
});
