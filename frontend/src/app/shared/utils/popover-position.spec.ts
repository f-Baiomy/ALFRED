import { computeFixedPanelPosition } from './popover-position';

describe('computeFixedPanelPosition', () => {
  let container: HTMLElement;

  afterEach(() => {
    container?.remove();
  });

  it('positions the panel directly below the trigger when nothing establishes a containing block', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const trigger = document.createElement('button');
    container.appendChild(trigger);
    spyOn(trigger, 'getBoundingClientRect').and.returnValue({
      top: 100,
      bottom: 130,
      left: 200,
      right: 260,
      width: 60,
      height: 30,
      x: 200,
      y: 100,
      toJSON: () => ({}),
    });

    const result = computeFixedPanelPosition(trigger, { width: 280, gap: 8 });

    expect(result).toEqual({ top: 138, left: 200 });
  });

  it('corrects for an ancestor with backdrop-filter, which becomes the containing block for fixed descendants', () => {
    container = document.createElement('div');
    container.style.backdropFilter = 'blur(3px)';
    document.body.appendChild(container);
    spyOn(container, 'getBoundingClientRect').and.returnValue({
      top: 45.6,
      bottom: 300,
      left: 0,
      right: 900,
      width: 900,
      height: 254.4,
      x: 0,
      y: 45.6,
      toJSON: () => ({}),
    });

    const trigger = document.createElement('button');
    container.appendChild(trigger);
    spyOn(trigger, 'getBoundingClientRect').and.returnValue({
      top: 128,
      bottom: 163.2,
      left: 370,
      right: 474,
      width: 104,
      height: 35.2,
      x: 370,
      y: 128,
      toJSON: () => ({}),
    });

    const result = computeFixedPanelPosition(trigger, { width: 320, gap: 8 });

    // Without the correction this would be {top: 171.2, left: 370} - browser then renders it
    // 45.6px too low since backdrop-filter makes `container` the containing block, not the viewport.
    expect(result.top).toBeCloseTo(171.2 - 45.6, 5);
    expect(result.left).toBe(370);
  });

  it('clamps the left edge so the panel never renders off-screen for a trigger near the right edge', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const trigger = document.createElement('button');
    container.appendChild(trigger);
    spyOn(trigger, 'getBoundingClientRect').and.returnValue({
      top: 10,
      bottom: 40,
      left: 950,
      right: 990,
      width: 40,
      height: 30,
      x: 950,
      y: 10,
      toJSON: () => ({}),
    });
    spyOnProperty(window, 'innerWidth').and.returnValue(1000);

    const result = computeFixedPanelPosition(trigger, { width: 280, gap: 8 });

    expect(result.left).toBe(1000 - 280 - 8);
  });
});
