// src/app/core/services/paint-engine.service.ts

import { Injectable } from '@angular/core';
import { GeneratorConfig, GenerationResult, RGB } from '../models/types';

interface LAB {
  l: number;
  a: number;
  b: number;
}
interface Point {
  x: number;
  y: number;
}

@Injectable({
  providedIn: 'root',
})
export class PaintEngineService {
  /** Scopes every generated stylesheet rule to the SVG that owns it. */
  public static readonly ROOT_CLASS = 'pbn-root';

  /** Applied to each colour wash path in the final composite, alongside `pbn-fill-{colourId}`. */
  public static readonly FILL_CLASS = 'pbn-fill';

  /** Applied to each facet outline, alongside `pbn-outline-{colourId}`. */
  public static readonly OUTLINE_CLASS = 'pbn-outline';

  /** Applied to each facet number, alongside `pbn-label-{colourId}`. */
  public static readonly LABEL_CLASS = 'pbn-label';

  /**
   * Set on an ancestor of the SVG to freeze the painting animation in place.
   * The view toggles this while the download control is hovered or focused.
   */
  public static readonly PAUSED_CLASS = 'pbn-paused';

  /**
   * Resting opacity of a colour wash once it has been painted in.
   *
   * Full opacity, so a painted facet matches its palette swatch exactly. Anything less blends the
   * colour with the white page behind it and the artwork reads as a washed-out version of the
   * palette. Nothing needs to show through: a facet's outline and number are removed at the moment
   * its colour lands.
   */
  private static readonly FILL_OPACITY = 1;

  /** Seconds the animation rests while empty and again once fully painted. */
  private static readonly HOLD_SECONDS = 5;

  /** Seconds between one colour being painted in and the next. */
  private static readonly STEP_SECONDS = 0.5;

  /** Maximum k-means refinement passes before the current centroids are accepted. */
  private static readonly KMEANS_MAX_ITERATIONS = 15;

  /** Centroid movement in LAB units below which k-means is treated as converged. */
  private static readonly KMEANS_CONVERGENCE_DELTA = 0.1;

  /**
   * Maximum absorb passes when culling facets under the area threshold. Absorbing one facet can
   * push a neighbour under the threshold too, so the pass repeats until nothing moves.
   */
  private static readonly FACET_REDUCTION_PASSES = 4;

  /** Averaging passes applied to each traced boundary to soften the pixel staircase. */
  private static readonly BOUNDARY_SMOOTHING_PASSES = 3;

  public async processImage(file: File, config: GeneratorConfig): Promise<GenerationResult> {
    const img = await this.loadImage(file);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Failed to access 2D context');

    // strictly enforce downsampling limits while locking native image ratios
    let width = img.width;
    let height = img.height;
    if (width > config.maxImageDimension || height > config.maxImageDimension) {
      if (width > height) {
        height = Math.round((height * config.maxImageDimension) / width);
        width = config.maxImageDimension;
      } else {
        width = Math.round((width * config.maxImageDimension) / height);
        height = config.maxImageDimension;
      }
    }

    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(img, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;
    const totalPixels = width * height;

    // Perceptual CIELAB Color Space Quantization
    const labPixels: LAB[] = [];
    for (let i = 0; i < data.length; i += 4) {
      labPixels.push(this.rgbToLab({ r: data[i], g: data[i + 1], b: data[i + 2] }));
    }

    const labCentroids = this.runKMeansLab(labPixels, config.clusterCount);
    const palette: RGB[] = labCentroids.map((c) => this.labToRgb(c));
    const labels = new Int32Array(totalPixels);

    for (let i = 0; i < labPixels.length; i++) {
      let minDist = Infinity;
      let best = 0;
      const p = labPixels[i];
      for (let c = 0; c < labCentroids.length; c++) {
        const cent = labCentroids[c];
        const dist = Math.hypot(p.l - cent.l, p.a - cent.a, p.b - cent.b);
        if (dist < minDist) {
          minDist = dist;
          best = c;
        }
      }
      labels[i] = best;
    }

    const quantizedDataUrl = this.generateStageDataUrl(labels, palette, width, height);
    this.reduceFacets(labels, width, height, config.minFacetArea);
    const reductionDataUrl = this.generateStageDataUrl(labels, palette, width, height);

    const frequencyMap = new Map<number, number>();
    for (let i = 0; i < totalPixels; i++) {
      frequencyMap.set(labels[i], (frequencyMap.get(labels[i]) || 0) + 1);
    }

    // Number the palette by how much of the image each colour covers, so 1 is always the largest
    // area, 2 the next, and so on. Cluster indices come out of k-means in arbitrary order, which
    // would otherwise scatter the numbering across the template for no reason.
    //
    // Ties break on cluster index so a given image always numbers the same way.
    const displayNumberByCluster = new Map<number, number>();
    palette
      .map((_, clusterIndex) => clusterIndex)
      .sort((a, b) => (frequencyMap.get(b) ?? 0) - (frequencyMap.get(a) ?? 0) || a - b)
      .forEach((clusterIndex, rank) => displayNumberByCluster.set(clusterIndex, rank + 1));

    // The root class scopes every rule below. An inline <style> inside an inline SVG is applied
    // document-wide, so unscoped `path`/`text` selectors would restyle every other SVG on the page.
    const root = PaintEngineService.ROOT_CLASS;
    const svgHeader = `<svg xmlns="http://www.w3.org/2000/svg" class="${root}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" width="100%" height="100%">\n`;
    // Font size is deliberately omitted so each label can be scaled inline to the facet it sits in.
    const styleBase =
      `<style>` +
      `.${root} path { stroke: ${config.borderColor}; stroke-width: ${config.borderWidth}px; stroke-linejoin: round; stroke-linecap: round; fill: none; } ` +
      `.${root} text { font-family: system-ui, sans-serif; font-weight: 700; fill: ${config.labelColor}; text-anchor: middle; dominant-baseline: central; }` +
      `</style>\n`;

    let tracingSvgContent = '';
    let smoothedSegmentsContent = '';
    let placementElements = '';
    let finalCompositeLayers = '';

    const visited = new Uint8Array(totalPixels);
    const currentFacetGrid = new Uint8Array(totalPixels);

    // Connected Component Extraction
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const startIdx = y * width + x;
        if (visited[startIdx]) continue;

        const targetCluster = labels[startIdx];
        const componentIndices: number[] = [];
        const queue: number[] = [startIdx];
        visited[startIdx] = 1;
        currentFacetGrid[startIdx] = 1;

        let minX = x,
          maxX = x,
          minY = y,
          maxY = y;

        while (queue.length > 0) {
          const curr = queue.pop()!;
          componentIndices.push(curr);
          const cx = curr % width;
          const cy = Math.floor(curr / width);

          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;

          const neighbors = [
            { nx: cx + 1, ny: cy },
            { nx: cx - 1, ny: cy },
            { nx: cx, ny: cy + 1 },
            { nx: cx, ny: cy - 1 },
          ];

          for (const n of neighbors) {
            if (n.nx >= 0 && n.nx < width && n.ny >= 0 && n.ny < height) {
              const nIdx = n.ny * width + n.nx;
              if (!visited[nIdx] && labels[nIdx] === targetCluster) {
                visited[nIdx] = 1;
                currentFacetGrid[nIdx] = 1;
                queue.push(nIdx);
              }
            }
          }
        }

        // Trace un-smoothed integer contours
        const rawPathData = this.traceContourPath(
          componentIndices,
          currentFacetGrid,
          width,
          height,
        );
        if (rawPathData) {
          tracingSvgContent += `  <path d="${rawPathData}" stroke="#888" stroke-width="0.15px" />\n`;
        }

        // Extract Wavelet-smoothed shared border segments
        const smoothedPathData = this.extractAndSmoothFacetBoundary(
          componentIndices,
          currentFacetGrid,
          labels,
          width,
          height,
        );

        if (smoothedPathData) {
          const fillHex = this.rgbToHex(palette[targetCluster]);
          smoothedSegmentsContent += `  <path d="${smoothedPathData}" stroke="#333" stroke-width="0.3px" />\n`;

          // =====================================================================
          // CRITICAL FEATURE: Maximum Inscribed Square Label Placement
          // =====================================================================
          // Calculate the optimal internal bounding box using distance transformation
          const labelBox = this.findMaximumInscribedSquare(
            componentIndices,
            currentFacetGrid,
            minX,
            minY,
            maxX,
            maxY,
            width,
          );

          // Calculate precise midpoint vector anchors centered inside the target square
          const labelX = labelBox.x + labelBox.size / 2;
          const labelY = labelBox.y + labelBox.size / 2;

          // Apply proportional padding scale factor ensuring text fits cleanly without colliding with borders
          // Clamp absolute minimum rendering sizes to ensure micro-facets remain identifiable
          const calculatedFontSize = Math.max(1.2, Number((labelBox.size * 0.65).toFixed(2)));

          // Render diagnostic placement bounds (Visualizing exactly how inscribed boxes fit inside complex blobs)
          placementElements += `  <path d="${smoothedPathData}" stroke="#bbbbbb" stroke-width="0.2px" />\n`;
          placementElements += `  <rect x="${labelBox.x}" y="${labelBox.y}" width="${labelBox.size}" height="${labelBox.size}" fill="#ff0000" opacity="0.4" stroke="#cc0000" stroke-width="0.2px" />\n`;
          placementElements += `  <circle cx="${labelX}" cy="${labelY}" r="0.4" fill="#0000ff" />\n`;

          // Compile the master SVG layer: colour wash, outline, then the label on top.
          //
          // The colour is written as an inline `style` rather than a `fill` attribute on purpose.
          // Presentation attributes sit at the very bottom of the cascade, so the `fill: none` rule
          // in styleBase above would override a `fill="..."` attribute and the wash would never
          // render. An inline style declaration outranks that rule.
          //
          // The wash is also stroked in its own colour, at the same width as the outline it sits
          // under. Once a facet is painted its outline is hidden, and without this the hairline the
          // outline used to occupy would show through as an unpainted seam between neighbours.
          //
          // Every layer carries a per-colour class so the view can drive the painting animation
          // without re-parsing path data. See buildPaintAnimationCss().
          const colourId = displayNumberByCluster.get(targetCluster)!;
          const fillClasses = `${PaintEngineService.FILL_CLASS} ${PaintEngineService.FILL_CLASS}-${colourId}`;
          const outlineClasses = `${PaintEngineService.OUTLINE_CLASS} ${PaintEngineService.OUTLINE_CLASS}-${colourId}`;
          const labelClasses = `${PaintEngineService.LABEL_CLASS} ${PaintEngineService.LABEL_CLASS}-${colourId}`;

          finalCompositeLayers += `  <g>\n`;
          finalCompositeLayers += `    <path class="${fillClasses}" d="${smoothedPathData}" style="fill: ${fillHex}; stroke: ${fillHex}" fill-rule="evenodd" opacity="${PaintEngineService.FILL_OPACITY}" />\n`;
          finalCompositeLayers += `    <path class="${outlineClasses}" d="${smoothedPathData}" />\n`;
          finalCompositeLayers += `    <text class="${labelClasses}" x="${labelX.toFixed(2)}" y="${labelY.toFixed(2)}" font-size="${calculatedFontSize}px">${colourId}</text>\n`;
          finalCompositeLayers += `  </g>\n`;
        }

        // Clean lookup maps cleanly for the next shape extraction
        for (const idx of componentIndices) {
          currentFacetGrid[idx] = 0;
        }
      }
    }

    const tracingSvg = svgHeader + styleBase + tracingSvgContent + `</svg>`;
    const segmentSvg = svgHeader + styleBase + smoothedSegmentsContent + `</svg>`;
    const placementSvg = svgHeader + styleBase + placementElements + `</svg>`;
    const finalSvg = svgHeader + styleBase + finalCompositeLayers + `</svg>`;

    // Sorting by id is the same as sorting by descending area, since that is how ids were assigned.
    const finalPalette = palette
      .map((rgb, index) => ({
        id: displayNumberByCluster.get(index)!,
        hex: this.rgbToHex(rgb),
        percentage: Number((((frequencyMap.get(index) ?? 0) / totalPixels) * 100).toFixed(1)),
      }))
      .sort((a, b) => a.id - b.id);

    return {
      width,
      height,
      quantizedDataUrl,
      reductionDataUrl,
      tracingSvg,
      segmentSvg,
      placementSvg,
      finalSvg,
      palette: finalPalette,
    };
  }

  // =========================================================================
  // PAINTING ANIMATION
  // =========================================================================

  /**
   * Builds the display-only stylesheet that animates the final composite being painted in.
   *
   * For K colours ordered from the largest share of the image to the smallest, one cycle runs:
   *
   *   hold empty (5s)
   *     -> paint one colour every 0.5s, largest area first    ((K-1) * 0.5 seconds)
   *   hold fully painted (5s)
   *     -> snap back to empty and repeat forever
   *
   * As each colour is painted, the outlines and numbers belonging to it are hidden in the same
   * step, so a finished region reads as solid paint rather than a filled-in template. The wash is
   * stroked in its own colour (see processImage) so the vanished outline leaves no seam.
   *
   * Every layer is driven by its own keyframes rather than a JavaScript timer. The browser owns
   * the timing, nothing has to be torn down when the component is destroyed, and the whole
   * sequence can be frozen by toggling a single class on any ancestor.
   *
   * This is deliberately NOT baked into GenerationResult.finalSvg. That string is what the user
   * downloads, and a template meant for printing must be static, fully coloured, and still carry
   * its outlines and numbers.
   *
   * @param palette Palette from a GenerationResult, ordered by descending percentage.
   * @returns An SVG `<style>` element, or an empty string when there is nothing to animate.
   */
  public buildPaintAnimationCss(palette: GenerationResult['palette']): string {
    const colourCount = palette.length;
    if (colourCount === 0) return '';

    const hold = PaintEngineService.HOLD_SECONDS;
    const step = PaintEngineService.STEP_SECONDS;
    const fill = PaintEngineService.FILL_CLASS;
    const outline = PaintEngineService.OUTLINE_CLASS;
    const label = PaintEngineService.LABEL_CLASS;

    // K colours applied one per step span K-1 intervals, not K: the first lands the instant the
    // opening rest ends and the last lands when the pass is complete. Counting K here would add a
    // spurious extra step to the rest periods.
    const passSeconds = (colourCount - 1) * step;

    // Rest empty, paint in, rest painted. The wrap back to 0% is the jump straight to empty.
    const totalSeconds = hold * 2 + passSeconds;
    const asPercent = (seconds: number) => Number(((seconds / totalSeconds) * 100).toFixed(4));

    // step-end holds each declaration until the next one, giving a clean switch per colour rather
    // than a fade. Each colour keeps its painted state through to the end of the cycle.
    const keyframes = palette
      .map((entry, index) => {
        // Index 0 holds the largest share of the image, so it is painted first.
        const paintedAt = asPercent(hold + index * step);

        return (
          `@keyframes pbn-paint-${entry.id} { ` +
          `0% { opacity: 0; } ` +
          `${paintedAt}% { opacity: ${PaintEngineService.FILL_OPACITY}; } ` +
          `} ` +
          `@keyframes pbn-clear-${entry.id} { ` +
          `0% { opacity: 1; } ` +
          `${paintedAt}% { opacity: 0; } ` +
          `}`
        );
      })
      .join(' ');

    const assignments = palette
      .map(
        (entry) =>
          `.${fill}-${entry.id} { animation-name: pbn-paint-${entry.id}; } ` +
          `.${outline}-${entry.id}, .${label}-${entry.id} { animation-name: pbn-clear-${entry.id}; }`,
      )
      .join(' ');

    const timing = `animation-duration: ${totalSeconds}s; animation-timing-function: step-end; animation-iteration-count: infinite;`;

    return (
      `<style>` +
      `.${fill} { opacity: 0; ${timing} } ` +
      `.${outline}, .${label} { opacity: 1; ${timing} } ` +
      `${keyframes} ${assignments} ` +
      `.${PaintEngineService.PAUSED_CLASS} .${fill}, ` +
      `.${PaintEngineService.PAUSED_CLASS} .${outline}, ` +
      `.${PaintEngineService.PAUSED_CLASS} .${label} { animation-play-state: paused; } ` +
      `@media (prefers-reduced-motion: reduce) { ` +
      `.${fill} { animation: none; opacity: ${PaintEngineService.FILL_OPACITY}; } ` +
      `.${outline}, .${label} { animation: none; opacity: 0; } ` +
      `}` +
      `</style>\n`
    );
  }

  // =========================================================================
  // DISTANCE TRANSFORM & MAXIMUM INSCRIBED SQUARE SEARCH LOGIC
  // =========================================================================

  /**
   * Scans a localized component matrix to isolate the maximum viable internal square ($S \times S$)
   * where all internal pixels strictly belong to the current target facet.
   */
  private findMaximumInscribedSquare(
    indices: number[],
    facetGrid: Uint8Array,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    masterWidth: number,
  ): { x: number; y: number; size: number } {
    const boxW = maxX - minX + 1;
    const boxH = maxY - minY + 1;

    // 1. Allocate a localized lookup grid representing the active bounding box
    const localGrid = new Uint8Array(boxW * boxH);
    for (const idx of indices) {
      const lx = (idx % masterWidth) - minX;
      const ly = Math.floor(idx / masterWidth) - minY;
      localGrid[ly * boxW + lx] = 1;
    }

    // 2. Dynamic Programming Square Expansion (Maximal Square Matrix algorithm)
    // dp[y][x] stores the side length of the largest valid square whose bottom-right corner is at (x, y)
    const dp = new Int32Array(boxW * boxH);
    let maxSize = 0;
    let bestX = 0;
    let bestY = 0;

    for (let y = 0; y < boxH; y++) {
      for (let x = 0; x < boxW; x++) {
        const idx = y * boxW + x;

        if (localGrid[idx] === 1) {
          if (x === 0 || y === 0) {
            dp[idx] = 1;
          } else {
            // Expand square safely by taking the minimum valid expansion boundaries of adjacent top/left cells
            const valTop = dp[(y - 1) * boxW + x];
            const valLeft = dp[y * boxW + (x - 1)];
            const valTopLeft = dp[(y - 1) * boxW + (x - 1)];

            dp[idx] = Math.min(valTop, valLeft, valTopLeft) + 1;
          }

          // Track the coordinates yielding the absolute maximal viable interior surface dimensions
          if (dp[idx] > maxSize) {
            maxSize = dp[idx];
            bestX = x;
            bestY = y;
          }
        }
      }
    }

    // If the region is extremely small or thin, fall back cleanly to calculated visual center-of-mass bounds
    if (maxSize <= 1) {
      let sumX = 0,
        sumY = 0;
      for (const idx of indices) {
        sumX += idx % masterWidth;
        sumY += Math.floor(idx / masterWidth);
      }
      return {
        x: Number((sumX / indices.length).toFixed(2)),
        y: Number((sumY / indices.length).toFixed(2)),
        size: 1.5, // Secure fallback sizing perimeter
      };
    }

    // Calculate absolute root rendering origin (Top-Left corner derived from Bottom-Right target states)
    const finalTopLeftX = bestX - maxSize + 1 + minX;
    const finalTopLeftY = bestY - maxSize + 1 + minY;

    return {
      x: finalTopLeftX,
      y: finalTopLeftY,
      size: maxSize,
    };
  }

  // =========================================================================
  // BORDER TRACING LOGIC
  // =========================================================================

  private traceContourPath(
    indices: number[],
    facetMembership: Uint8Array,
    width: number,
    height: number,
  ): string {
    let pathString = '';
    const isMember = (nx: number, ny: number) =>
      nx >= 0 && nx < width && ny >= 0 && ny < height && facetMembership[ny * width + nx] === 1;

    for (const idx of indices) {
      const x = idx % width;
      const y = Math.floor(idx / width);

      if (!isMember(x, y - 1) && y > 0) pathString += `M ${x} ${y} L ${x + 1} ${y} `;
      if (!isMember(x + 1, y) && x < width - 1)
        pathString += `M ${x + 1} ${y} L ${x + 1} ${y + 1} `;
      if (!isMember(x, y + 1) && y < height - 1)
        pathString += `M ${x + 1} ${y + 1} L ${x} ${y + 1} `;
      if (!isMember(x - 1, y) && x > 0) pathString += `M ${x} ${y + 1} L ${x} ${y} `;
    }
    return pathString.trim();
  }

  // =========================================================================
  // PLANAR SEGMENTATION & WAVELET SMOOTHING LOGIC
  // =========================================================================

  private extractAndSmoothFacetBoundary(
    indices: number[],
    facetGrid: Uint8Array,
    globalLabels: Int32Array,
    width: number,
    height: number,
  ): string {
    interface Segment {
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    }
    const segments: Segment[] = [];
    const isMember = (nx: number, ny: number) =>
      nx >= 0 && nx < width && ny >= 0 && ny < height && facetGrid[ny * width + nx] === 1;

    for (const idx of indices) {
      const x = idx % width;
      const y = Math.floor(idx / width);
      if (!isMember(x, y - 1) && y > 0) segments.push({ x1: x, y1: y, x2: x + 1, y2: y });
      if (!isMember(x + 1, y) && x < width - 1)
        segments.push({ x1: x + 1, y1: y, x2: x + 1, y2: y + 1 });
      if (!isMember(x, y + 1) && y < height - 1)
        segments.push({ x1: x + 1, y1: y + 1, x2: x, y2: y + 1 });
      if (!isMember(x - 1, y) && x > 0) segments.push({ x1: x, y1: y + 1, x2: x, y2: y });
    }

    if (segments.length === 0) return '';

    // Stitch the loose unit-length border segments into continuous chains by repeatedly looking for
    // a segment that touches either end of the chain being built.
    //
    // PERFORMANCE: this rescans the whole segment list on every extension, making it O(n^2) in the
    // number of border segments. It is the dominant cost of a run on a large or detailed image.
    // Indexing segments by their endpoints would make each lookup constant time; left as-is for now
    // because it changes the order chains are assembled in, which needs a visual regression check.
    const chains: Point[][] = [];
    const used = new Uint8Array(segments.length);

    for (let i = 0; i < segments.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      const currentChain: Point[] = [
        { x: segments[i].x1, y: segments[i].y1 },
        { x: segments[i].x2, y: segments[i].y2 },
      ];

      let extended = true;
      while (extended) {
        extended = false;
        const firstPt = currentChain[0];
        const lastPt = currentChain[currentChain.length - 1];

        for (let j = 0; j < segments.length; j++) {
          if (used[j]) continue;
          if (segments[j].x1 === lastPt.x && segments[j].y1 === lastPt.y) {
            currentChain.push({ x: segments[j].x2, y: segments[j].y2 });
            used[j] = 1;
            extended = true;
            break;
          } else if (segments[j].x2 === lastPt.x && segments[j].y2 === lastPt.y) {
            currentChain.push({ x: segments[j].x1, y: segments[j].y1 });
            used[j] = 1;
            extended = true;
            break;
          } else if (segments[j].x2 === firstPt.x && segments[j].y2 === firstPt.y) {
            currentChain.unshift({ x: segments[j].x1, y: segments[j].y1 });
            used[j] = 1;
            extended = true;
            break;
          } else if (segments[j].x1 === firstPt.x && segments[j].y1 === firstPt.y) {
            currentChain.unshift({ x: segments[j].x2, y: segments[j].y2 });
            used[j] = 1;
            extended = true;
            break;
          }
        }
      }
      if (currentChain.length > 2) chains.push(currentChain);
    }

    /**
     * A point is a junction when three or more clusters meet at it, or when it sits on the image
     * edge. Junctions are pinned during smoothing: moving them would pull the shared borders of
     * adjacent facets apart and leave visible gaps between regions that should touch exactly.
     */
    const isTrueJunction = (pt: Point): boolean => {
      if (pt.x <= 0 || pt.x >= width || pt.y <= 0 || pt.y >= height) return true;
      const uniqueColors = new Set<number>();
      const quadrants = [
        { cx: pt.x - 1, cy: pt.y - 1 },
        { cx: pt.x, cy: pt.y - 1 },
        { cx: pt.x - 1, cy: pt.y },
        { cx: pt.x, cy: pt.y },
      ];
      for (const q of quadrants) {
        if (q.cx >= 0 && q.cx < width && q.cy >= 0 && q.cy < height)
          uniqueColors.add(globalLabels[q.cy * width + q.cx]);
      }
      return uniqueColors.size >= 3;
    };

    let masterPathString = '';

    for (const chain of chains) {
      const isClosed =
        chain[0].x === chain[chain.length - 1].x && chain[0].y === chain[chain.length - 1].y;
      let smoothedChain = [...chain];

      // Each pass replaces a point with a weighted average of itself and its two neighbours
      // (1:2:1), which rounds off the single-pixel staircase left by the integer tracing step.
      for (let iter = 0; iter < PaintEngineService.BOUNDARY_SMOOTHING_PASSES; iter++) {
        const nextChain: Point[] = [];
        const len = smoothedChain.length;

        for (let i = 0; i < len; i++) {
          if (!isClosed && (i === 0 || i === len - 1)) {
            nextChain.push(smoothedChain[i]);
            continue;
          }
          const prev = smoothedChain[(i - 1 + len) % len];
          const curr = smoothedChain[i];
          const next = smoothedChain[(i + 1) % len];

          if (isTrueJunction(curr)) nextChain.push(curr);
          else
            nextChain.push({
              x: (prev.x + curr.x * 2 + next.x) / 4,
              y: (prev.y + curr.y * 2 + next.y) / 4,
            });
        }
        smoothedChain = nextChain;
      }
      masterPathString += this.pointsToPathString(smoothedChain, isClosed) + ' ';
    }

    return masterPathString.trim();
  }

  private pointsToPathString(points: Point[], isClosed: boolean): string {
    if (points.length < 2) return '';
    let s = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)} `;
    for (let i = 1; i < points.length; i++)
      s += `L ${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)} `;
    return isClosed ? s + 'Z' : s;
  }

  // =========================================================================
  // CORE QUANTIZATION & COLOR SPACE MATH
  // =========================================================================

  /**
   * Absorbs facets smaller than `minArea` into whichever neighbouring cluster they share the most
   * border with, removing the speckle that would otherwise produce unpaintable one-pixel regions.
   *
   * Runs repeatedly because absorbing a facet can merge two regions and drop a neighbour below the
   * threshold in turn. Stops early once a pass changes nothing.
   */
  private reduceFacets(labels: Int32Array, width: number, height: number, minArea: number): void {
    const totalPixels = width * height;
    const visited = new Uint8Array(totalPixels);
    for (let pass = 0; pass < PaintEngineService.FACET_REDUCTION_PASSES; pass++) {
      let absorbedCount = 0;
      visited.fill(0);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const startIdx = y * width + x;
          if (visited[startIdx]) continue;
          const targetCluster = labels[startIdx];
          const componentIndices: number[] = [];
          const queue: number[] = [startIdx];
          visited[startIdx] = 1;
          const borderFrequency = new Map<number, number>();

          while (queue.length > 0) {
            const curr = queue.pop()!;
            componentIndices.push(curr);
            const cx = curr % width;
            const cy = Math.floor(curr / width);
            const neighbors = [
              { nx: cx + 1, ny: cy },
              { nx: cx - 1, ny: cy },
              { nx: cx, ny: cy + 1 },
              { nx: cx, ny: cy - 1 },
            ];
            for (const n of neighbors) {
              if (n.nx >= 0 && n.nx < width && n.ny >= 0 && n.ny < height) {
                const nIdx = n.ny * width + n.nx;
                const nCluster = labels[nIdx];
                if (nCluster === targetCluster) {
                  if (!visited[nIdx]) {
                    visited[nIdx] = 1;
                    queue.push(nIdx);
                  }
                } else {
                  borderFrequency.set(nCluster, (borderFrequency.get(nCluster) || 0) + 1);
                }
              }
            }
          }
          if (componentIndices.length < minArea) {
            let bestNeighbor = targetCluster;
            let maxContact = -1;
            borderFrequency.forEach((count, clusterId) => {
              if (count > maxContact) {
                maxContact = count;
                bestNeighbor = clusterId;
              }
            });
            if (bestNeighbor !== targetCluster) {
              for (const idx of componentIndices) labels[idx] = bestNeighbor;
              absorbedCount++;
            }
          }
        }
      }
      if (absorbedCount === 0) break;
    }
  }

  /**
   * Groups pixels into k colour clusters by Lloyd's algorithm, working in LAB so that distance
   * between two colours matches how different they look rather than how different their RGB
   * numbers are.
   *
   * Seeds are picked at random but de-duplicated: two identical seeds collapse into one cluster and
   * leave the user with fewer colours than they asked for, which is very likely on images with
   * large flat areas where the same colour dominates the sample.
   */
  private runKMeansLab(pixels: LAB[], k: number): LAB[] {
    const centroids: LAB[] = [];
    const seen = new Set<string>();

    // Try to find k distinct seeds, but never spin forever on an image with fewer than k colours.
    for (let attempt = 0; attempt < pixels.length && centroids.length < k; attempt++) {
      const candidate = pixels[Math.floor(Math.random() * pixels.length)];
      const key = `${candidate.l}|${candidate.a}|${candidate.b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      centroids.push({ ...candidate });
    }
    // Fall back to duplicating a seed if the image genuinely has fewer distinct colours than k.
    while (centroids.length < k) centroids.push({ ...pixels[0] });

    for (let iter = 0; iter < PaintEngineService.KMEANS_MAX_ITERATIONS; iter++) {
      const sums = Array.from({ length: k }, () => ({ l: 0, a: 0, b: 0, count: 0 }));
      for (const p of pixels) {
        let minDist = Infinity;
        let best = 0;
        for (let c = 0; c < k; c++) {
          const dist = Math.hypot(p.l - centroids[c].l, p.a - centroids[c].a, p.b - centroids[c].b);
          if (dist < minDist) {
            minDist = dist;
            best = c;
          }
        }
        sums[best].l += p.l;
        sums[best].a += p.a;
        sums[best].b += p.b;
        sums[best].count++;
      }
      let moved = false;
      for (let c = 0; c < k; c++) {
        if (sums[c].count > 0) {
          const nl = sums[c].l / sums[c].count;
          const na = sums[c].a / sums[c].count;
          const nb = sums[c].b / sums[c].count;
          const delta = PaintEngineService.KMEANS_CONVERGENCE_DELTA;
          if (
            Math.abs(centroids[c].l - nl) > delta ||
            Math.abs(centroids[c].a - na) > delta ||
            Math.abs(centroids[c].b - nb) > delta
          )
            moved = true;
          centroids[c] = { l: nl, a: na, b: nb };
        }
      }
      if (!moved) break;
    }
    return centroids;
  }

  /**
   * Converts sRGB to CIELAB via XYZ, using the D65 white point (95.047, 100, 108.883).
   *
   * The first step undoes the sRGB gamma curve so the channel values are linear light, which is
   * what the XYZ matrix expects. Skipping it is the usual cause of muddy quantization results.
   */
  private rgbToLab(color: RGB): LAB {
    let r = color.r / 255;
    let g = color.g / 255;
    let b = color.b / 255;
    r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
    g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
    b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;
    r *= 100;
    g *= 100;
    b *= 100;
    const x = r * 0.4124 + g * 0.3576 + b * 0.1805;
    const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const z = r * 0.0193 + g * 0.1192 + b * 0.9505;
    let px = x / 95.047;
    let py = y / 100.0;
    let pz = z / 108.883;
    px = px > 0.008856 ? Math.pow(px, 1 / 3) : 7.787 * px + 16 / 116;
    py = py > 0.008856 ? Math.pow(py, 1 / 3) : 7.787 * py + 16 / 116;
    pz = pz > 0.008856 ? Math.pow(pz, 1 / 3) : 7.787 * pz + 16 / 116;
    return { l: 116 * py - 16, a: 500 * (px - py), b: 200 * (py - pz) };
  }

  /**
   * Inverse of rgbToLab. Channels are clamped to 0-255 because a LAB centroid averaged from real
   * pixels can land just outside the sRGB gamut.
   */
  private labToRgb(lab: LAB): RGB {
    let py = (lab.l + 16) / 116;
    let px = lab.a / 500 + py;
    let pz = py - lab.b / 200;
    const py3 = Math.pow(py, 3);
    const px3 = Math.pow(px, 3);
    const pz3 = Math.pow(pz, 3);
    px = px3 > 0.008856 ? px3 : (px - 16 / 116) / 7.787;
    py = py3 > 0.008856 ? py3 : (py - 16 / 116) / 7.787;
    pz = pz3 > 0.008856 ? pz3 : (pz - 16 / 116) / 7.787;
    const x = (px * 95.047) / 100;
    const y = (py * 100.0) / 100;
    const z = (pz * 108.883) / 100;
    let r = x * 3.2406 + y * -1.5372 + z * -0.4986;
    let g = x * -0.9689 + y * 1.8758 + z * 0.0415;
    let b = x * 0.0557 + y * -0.204 + z * 1.057;
    r = r > 0.0031308 ? 1.055 * Math.pow(r, 1 / 2.4) - 0.055 : 12.92 * r;
    g = g > 0.0031308 ? 1.055 * Math.pow(g, 1 / 2.4) - 0.055 : 12.92 * g;
    b = b > 0.0031308 ? 1.055 * Math.pow(b, 1 / 2.4) - 0.055 : 12.92 * b;
    return {
      r: Math.min(255, Math.max(0, Math.round(r * 255))),
      g: Math.min(255, Math.max(0, Math.round(g * 255))),
      b: Math.min(255, Math.max(0, Math.round(b * 255))),
    };
  }

  private generateStageDataUrl(
    labels: Int32Array,
    palette: RGB[],
    width: number,
    height: number,
  ): string {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to access 2D context');

    const imgData = ctx.createImageData(width, height);
    const d = imgData.data;
    for (let i = 0; i < labels.length; i++) {
      const c = palette[labels[i]];
      const offset = i * 4;
      d[offset] = c.r;
      d[offset + 1] = c.g;
      d[offset + 2] = c.b;
      d[offset + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas.toDataURL();
  }

  private loadImage(file: File): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = (e) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = e.target?.result as string;
      };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  private rgbToHex(color: RGB): string {
    return `#${color.r.toString(16).padStart(2, '0')}${color.g.toString(16).padStart(2, '0')}${color.b.toString(16).padStart(2, '0')}`;
  }
}
