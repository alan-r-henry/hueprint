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
 * Pulls the keyframe offsets for one colour out of the generated stylesheet.
 *
 * The block is located by brace matching rather than a regex, because keyframe bodies nest one
 * level of braces and a naive `[^}]*` stops at the first inner close.
 */
function offsetsFor(css: string, id: number): { painted: number; cleared: number } {
  const start = css.indexOf(`@keyframes pbn-cycle-${id} {`);
  if (start === -1) throw new Error(`no keyframes for colour ${id}`);

  let depth = 0;
  let end = -1;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error(`unterminated keyframes for colour ${id}`);

  const stops = [...css.slice(start, end).matchAll(/([\d.]+)% \{ opacity: ([\d.]+); \}/g)];
  const painted = stops.find((s) => Number(s[2]) > 0);
  const cleared = stops.filter((s) => Number(s[2]) === 0).pop();
  if (!painted || !cleared) throw new Error(`incomplete keyframes for colour ${id}`);

  return { painted: Number(painted[1]), cleared: Number(cleared[1]) };
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

    it('runs for three rest periods plus a paint-in and paint-out pass', () => {
      // 8 colours at one per second span 7 intervals each way, plus 3 x 5s of rest.
      const css = service.buildPaintAnimationCss(paletteOf(30, 20, 15, 10, 9, 8, 5, 3));
      expect(css).toContain('animation-duration: 29s');
    });

    it('collapses to a single hold-fill-hold cycle for one colour', () => {
      const css = service.buildPaintAnimationCss(paletteOf(100));
      expect(css).toContain('animation-duration: 15s');
    });

    it('paints the largest area first and the smallest last', () => {
      const css = service.buildPaintAnimationCss(paletteOf(50, 30, 20));
      const first = offsetsFor(css, 1);
      const second = offsetsFor(css, 2);
      const third = offsetsFor(css, 3);

      expect(first.painted).toBeLessThan(second.painted);
      expect(second.painted).toBeLessThan(third.painted);
    });

    it('clears the smallest area first and the largest last', () => {
      const css = service.buildPaintAnimationCss(paletteOf(50, 30, 20));
      const first = offsetsFor(css, 1);
      const second = offsetsFor(css, 2);
      const third = offsetsFor(css, 3);

      // The largest share is painted first, so it survives to the end of the wipe.
      expect(third.cleared).toBeLessThan(second.cleared);
      expect(second.cleared).toBeLessThan(first.cleared);
    });

    it('keeps every colour on screen between being painted and being cleared', () => {
      const css = service.buildPaintAnimationCss(paletteOf(50, 30, 20));

      for (const id of [1, 2, 3]) {
        const { painted, cleared } = offsetsFor(css, id);
        expect(painted).toBeGreaterThan(0);
        expect(cleared).toBeGreaterThan(painted);
        expect(cleared).toBeLessThan(100);
      }
    });

    it('opens the cycle with every colour hidden', () => {
      const css = service.buildPaintAnimationCss(paletteOf(60, 40));
      expect(css).toContain('0% { opacity: 0; }');
    });

    it('exposes a pause hook and honours reduced-motion preferences', () => {
      const css = service.buildPaintAnimationCss(paletteOf(60, 40));
      expect(css).toContain(
        `.${PaintEngineService.PAUSED_CLASS} .${PaintEngineService.FILL_CLASS}`,
      );
      expect(css).toContain('animation-play-state: paused');
      expect(css).toContain('prefers-reduced-motion: reduce');
    });

    it('binds one keyframe set per palette entry', () => {
      const css = service.buildPaintAnimationCss(paletteOf(40, 30, 20, 10));
      const keyframeCount = [...css.matchAll(/@keyframes pbn-cycle-\d+/g)].length;
      expect(keyframeCount).toBe(4);
    });
  });
});
