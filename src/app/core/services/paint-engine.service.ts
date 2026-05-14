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
  public async processImage(file: File, config: GeneratorConfig): Promise<GenerationResult> {
    const img = await this.loadImage(file);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Failed to access 2D context');

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

    // Perceptual Quantization Pipeline (CIELAB Space)
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

    const svgHeader = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" width="100%" height="100%">\n`;
    const styleBase = `<style>path { stroke: #444444; stroke-width: 0.3px; stroke-linejoin: round; stroke-linecap: round; fill: none; } text { font-family: system-ui, sans-serif; font-size: 2px; font-weight: 700; fill: #111; text-anchor: middle; dominant-baseline: central; }</style>\n`;

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

        let sumX = 0;
        let sumY = 0;
        let minX = x,
          maxX = x,
          minY = y,
          maxY = y;

        while (queue.length > 0) {
          const curr = queue.pop()!;
          componentIndices.push(curr);
          const cx = curr % width;
          const cy = Math.floor(curr / width);
          sumX += cx;
          sumY += cy;
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

        // Trace raw diagnostic integer contours
        const rawPathData = this.traceContourPath(
          componentIndices,
          currentFacetGrid,
          width,
          height,
        );
        if (rawPathData) {
          tracingSvgContent += `  <path d="${rawPathData}" stroke="#888" stroke-width="0.15px" />\n`;
        }

        // Extract Advanced Smoothed Planar Outlines using global label checking to find true multi-color junctions
        const smoothedPathData = this.extractAndSmoothFacetBoundary(
          componentIndices,
          currentFacetGrid,
          labels,
          width,
          height,
        );

        if (smoothedPathData) {
          const labelX = sumX / componentIndices.length + 0.5;
          const labelY = sumY / componentIndices.length + 0.5;
          const fillHex = this.rgbToHex(palette[targetCluster]);

          smoothedSegmentsContent += `  <path d="${smoothedPathData}" stroke="#333" stroke-width="0.3px" />\n`;

          const boxWidth = Math.max(1.5, (maxX - minX) * 0.2);
          const boxHeight = Math.max(1.5, (maxY - minY) * 0.2);

          placementElements += `  <path d="${smoothedPathData}" stroke="#bbbbbb" stroke-width="0.2px" />\n`;
          placementElements += `  <rect x="${labelX - boxWidth / 2}" y="${labelY - boxHeight / 2}" width="${boxWidth}" height="${boxHeight}" fill="#ff0000" opacity="0.8" />\n`;

          finalCompositeLayers += `  <g>\n`;
          finalCompositeLayers += `    <path d="${smoothedPathData}" fill="${fillHex}" fill-rule="evenodd" opacity="0.6" />\n`;
          finalCompositeLayers += `    <path d="${smoothedPathData}" />\n`;
          finalCompositeLayers += `    <text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}">${targetCluster + 1}</text>\n`;
          finalCompositeLayers += `  </g>\n`;
        }

        for (const idx of componentIndices) {
          currentFacetGrid[idx] = 0;
        }
      }
    }

    const tracingSvg = svgHeader + styleBase + tracingSvgContent + `</svg>`;
    const segmentSvg = svgHeader + styleBase + smoothedSegmentsContent + `</svg>`;
    const placementSvg = svgHeader + styleBase + placementElements + `</svg>`;
    const finalSvg = svgHeader + styleBase + finalCompositeLayers + `</svg>`;

    const finalPalette = palette
      .map((rgb, index) => ({
        id: index + 1,
        hex: this.rgbToHex(rgb),
        percentage: Number((((frequencyMap.get(index) || 0) / totalPixels) * 100).toFixed(1)),
      }))
      .sort((a, b) => b.percentage - a.percentage);

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
  // CRITICAL FIX: TRUE PLANAR SEGMENTATION & WAVELET SMOOTHING
  // =========================================================================

  /**
   * Evaluates vertex paths globally. Identifies true multi-color junction points where
   * multiple cluster IDs intersect, and averages internal segment nodes cleanly to achieve
   * fluid vector smoothing while preserving shared border geometry perfectly.
   */
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

    // Extract outer unit perimeter segments excluding layout borders
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

    // Chain contiguous unit vectors endpoint-to-endpoint into maximal raw path loops
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

    // Helper: Evaluates true multi-facet connectivity around a target integer grid vertex
    const isTrueJunction = (pt: Point): boolean => {
      // Points sitting on the layout perimeter are automatically treated as terminal anchors
      if (pt.x <= 0 || pt.x >= width || pt.y <= 0 || pt.y >= height) return true;

      // Gather unique color IDs from the 4 specific pixel quadrants sharing this corner vertex
      const uniqueColors = new Set<number>();
      const quadrants = [
        { cx: pt.x - 1, cy: pt.y - 1 },
        { cx: pt.x, cy: pt.y - 1 },
        { cx: pt.x - 1, cy: pt.y },
        { cx: pt.x, cy: pt.y },
      ];

      for (const q of quadrants) {
        if (q.cx >= 0 && q.cx < width && q.cy >= 0 && q.cy < height) {
          uniqueColors.add(globalLabels[q.cy * width + q.cx]);
        }
      }
      // A vertex is a true junction if three or more distinct visual color zones meet at this coordinate
      return uniqueColors.size >= 3;
    };

    let masterPathString = '';

    // Apply Multi-Pass Wavelet Averaging strictly protecting isolated multi-color junction nodes
    for (const chain of chains) {
      const isClosed =
        chain[0].x === chain[chain.length - 1].x && chain[0].y === chain[chain.length - 1].y;
      let smoothedChain = [...chain];
      const smoothingIterations = 3;

      for (let iter = 0; iter < smoothingIterations; iter++) {
        const nextChain: Point[] = [];
        const len = smoothedChain.length;

        for (let i = 0; i < len; i++) {
          // Terminal endpoints of open paths remain locked securely
          if (!isClosed && (i === 0 || i === len - 1)) {
            nextChain.push(smoothedChain[i]);
            continue;
          }

          const prev = smoothedChain[(i - 1 + len) % len];
          const curr = smoothedChain[i];
          const next = smoothedChain[(i + 1) % len];

          // CRITICAL FIX: Only freeze nodes that act as true multi-color planar interfaces
          if (isTrueJunction(curr)) {
            nextChain.push(curr);
          } else {
            // Apply Haar Wavelet localized point-averaging to soften pixel staircase segments
            nextChain.push({
              x: (prev.x + curr.x * 2 + next.x) / 4,
              y: (prev.y + curr.y * 2 + next.y) / 4,
            });
          }
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
    for (let i = 1; i < points.length; i++) {
      s += `L ${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)} `;
    }
    return isClosed ? s + 'Z' : s;
  }

  // =========================================================================
  // CORE MORPHOLOGY & CLUSTERING LOGIC
  // =========================================================================

  private reduceFacets(labels: Int32Array, width: number, height: number, minArea: number): void {
    const totalPixels = width * height;
    const visited = new Uint8Array(totalPixels);
    for (let pass = 0; pass < 4; pass++) {
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

  private runKMeansLab(pixels: LAB[], k: number): LAB[] {
    const centroids: LAB[] = [];
    for (let i = 0; i < k; i++)
      centroids.push({ ...pixels[Math.floor(Math.random() * pixels.length)] });
    for (let iter = 0; iter < 15; iter++) {
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
          if (
            Math.abs(centroids[c].l - nl) > 0.1 ||
            Math.abs(centroids[c].a - na) > 0.1 ||
            Math.abs(centroids[c].b - nb) > 0.1
          )
            moved = true;
          centroids[c] = { l: nl, a: na, b: nb };
        }
      }
      if (!moved) break;
    }
    return centroids;
  }

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
    const imgData = canvas.getContext('2d')!.createImageData(width, height);
    const d = imgData.data;
    for (let i = 0; i < labels.length; i++) {
      const c = palette[labels[i]];
      const offset = i * 4;
      d[offset] = c.r;
      d[offset + 1] = c.g;
      d[offset + 2] = c.b;
      d[offset + 3] = 255;
    }
    canvas.getContext('2d')!.putImageData(imgData, 0, 0);
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
