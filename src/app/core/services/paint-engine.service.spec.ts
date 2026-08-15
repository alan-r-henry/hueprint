import { TestBed } from '@angular/core/testing';
import { PaintEngineService } from './paint-engine.service';
import { GenerationResult } from '../models/types';

/** Builds a palette ordered by descending percentage, as processImage() returns it. */
function paletteOf(...percentages: number[]): GenerationResult['palette'] {
  return percentages.map((percentage, i) => ({
    id: i + 1,
    hex: '#000000',
    percentage,
  }));
}

/**
 * Returns the opacity stops of one keyframes block, as `[offsetPercent, opacity]` pairs.
 *
 * The block is located by brace matching rather than a regex, because keyframe bodies nest one
 * level of braces and a naive `[^}]*` stops at the first inner close.
 */
function stopsOf(css: string, keyframeName: string): Array<[number, number]> {
  const start = css.indexOf(`@keyframes ${keyframeName} {`);
  if (start === -1) throw new Error(`no keyframes named ${keyframeName}`);

  let depth = 0;
  let end = -1;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error(`unterminated keyframes for ${keyframeName}`);

  return [...css.slice(start, end).matchAll(/([\d.]+)% \{ opacity: ([\d.]+); \}/g)].map((m) => [
    Number(m[1]),
    Number(m[2]),
  ]);
}

/** The offset at which a colour's wash becomes visible. */
function paintOffset(css: string, id: number): number {
  const stop = stopsOf(css, `pbn-paint-${id}`).find(([, opacity]) => opacity > 0);
  if (!stop) throw new Error(`colour ${id} is never painted`);
  return stop[0];
}

/** The offset at which a colour's outline and number disappear. */
function clearOffset(css: string, id: number): number {
  const stop = stopsOf(css, `pbn-clear-${id}`).find(([, opacity]) => opacity === 0);
  if (!stop) throw new Error(`colour ${id} never clears its outline`);
  return stop[0];
}

describe('PaintEngineService', () => {
  let service: PaintEngineService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(PaintEngineService);
  });

  describe('buildPaintAnimationCss', () => {
    it('produces nothing when there is no palette', () => {
      expect(service.buildPaintAnimationCss([])).toBe('');
    });

    it('rests empty, paints in at half-second steps, then rests painted', () => {
      // 8 colours span 7 half-second intervals, plus 5s empty and 5s painted.
      const css = service.buildPaintAnimationCss(paletteOf(30, 20, 15, 10, 9, 8, 5, 3));
      expect(css).toContain('animation-duration: 13.5s');
    });

    it('collapses to just the two rest periods for a single colour', () => {
      const css = service.buildPaintAnimationCss(paletteOf(100));
      expect(css).toContain('animation-duration: 10s');
    });

    it('paints the largest area first and the smallest last', () => {
      const css = service.buildPaintAnimationCss(paletteOf(50, 30, 20));

      expect(paintOffset(css, 1)).toBeLessThan(paintOffset(css, 2));
      expect(paintOffset(css, 2)).toBeLessThan(paintOffset(css, 3));
    });

    it('hides each outline and number exactly when its colour is painted', () => {
      const css = service.buildPaintAnimationCss(paletteOf(50, 30, 20));

      for (const id of [1, 2, 3]) {
        expect(clearOffset(css, id)).toBe(paintOffset(css, id));
      }
    });

    it('keeps every colour painted through to the end of the cycle', () => {
      const css = service.buildPaintAnimationCss(paletteOf(50, 30, 20));

      for (const id of [1, 2, 3]) {
        const stops = stopsOf(css, `pbn-paint-${id}`);
        // Only the hidden start and the painted step: nothing sends a colour back to zero.
        expect(stops.length).toBe(2);
        expect(stops[stops.length - 1][1]).toBeGreaterThan(0);
      }
    });

    it('opens the cycle empty, with outlines and numbers showing', () => {
      const css = service.buildPaintAnimationCss(paletteOf(60, 40));

      expect(stopsOf(css, 'pbn-paint-1')[0]).toEqual([0, 0]);
      expect(stopsOf(css, 'pbn-clear-1')[0]).toEqual([0, 1]);
    });

    it('starts painting only after the opening rest', () => {
      // 3 colours over 11s total; the first colour lands at 5s.
      const css = service.buildPaintAnimationCss(paletteOf(50, 30, 20));
      expect(paintOffset(css, 1)).toBeCloseTo((5 / 11) * 100, 3);
    });

    it('pauses every animated layer through the pause hook', () => {
      const css = service.buildPaintAnimationCss(paletteOf(60, 40));
      const paused = PaintEngineService.PAUSED_CLASS;

      expect(css).toContain(`.${paused} .${PaintEngineService.FILL_CLASS}`);
      expect(css).toContain(`.${paused} .${PaintEngineService.OUTLINE_CLASS}`);
      expect(css).toContain(`.${paused} .${PaintEngineService.LABEL_CLASS}`);
      expect(css).toContain('animation-play-state: paused');
    });

    it('settles on the painted result when motion is reduced', () => {
      const css = service.buildPaintAnimationCss(paletteOf(60, 40));
      expect(css).toContain('prefers-reduced-motion: reduce');
    });

    it('binds a paint and a clear keyframe set per palette entry', () => {
      const css = service.buildPaintAnimationCss(paletteOf(40, 30, 20, 10));

      expect([...css.matchAll(/@keyframes pbn-paint-\d+/g)].length).toBe(4);
      expect([...css.matchAll(/@keyframes pbn-clear-\d+/g)].length).toBe(4);
    });
  });
});
