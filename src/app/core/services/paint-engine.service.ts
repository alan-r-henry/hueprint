// src/app/core/services/paint-engine.service.ts

import { Injectable } from '@angular/core';
import { GeneratorConfig, GenerationResult, RGB } from '../models/types';

interface LAB {
  l: number;
  a: number;
  b: number;
}

@Injectable({
  providedIn: 'root',
})
export class PaintEngineService {
  public async processImage(file: File, config: GeneratorConfig): Promise<GenerationResult> {
    const img = await this.loadImage(file);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Failed to get 2D context');

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

    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const totalPixels = width * height;

    // 1. Extract Pixels and convert directly to CIELAB space for perceptual processing
    const labPixels: LAB[] = [];
    for (let i = 0; i < data.length; i += 4) {
      const rgb = { r: data[i], g: data[i + 1], b: data[i + 2] };
      labPixels.push(this.rgbToLab(rgb));
    }

    // 2. Perform K-Means Clustering strictly within Perceptual LAB Space
    const labCentroids = this.runKMeansLab(labPixels, config.clusterCount);

    // Convert finalized Lab centroids back to master RGB palette array
    const palette: RGB[] = labCentroids.map((c) => this.labToRgb(c));
    const labels = new Int32Array(totalPixels);
    const frequencyMap = new Map<number, number>();

    // Assign pixels to closest perceptual cluster ID
    for (let i = 0; i < labPixels.length; i++) {
      let minDist = Infinity;
      let bestCluster = 0;
      const p = labPixels[i];

      for (let c = 0; c < labCentroids.length; c++) {
        const cent = labCentroids[c];
        // Euclidean distance in Lab space matches human visual sensitivity
        const dist = Math.hypot(p.l - cent.l, p.a - cent.a, p.b - cent.b);
        if (dist < minDist) {
          minDist = dist;
          bestCluster = c;
        }
      }
      labels[i] = bestCluster;
      frequencyMap.set(bestCluster, (frequencyMap.get(bestCluster) || 0) + 1);
    }

    // Generate output raster stage DataURLs
    const quantizedDataUrl = this.generateStageDataUrl(labels, palette, width, height);
    const reductionDataUrl = this.generateReductionStage(
      labels,
      palette,
      width,
      height,
      config.minFacetArea,
    );

    // Vector pipeline compilation
    const svgHeader = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="100%">\n`;
    const styleBase = `<style>path { stroke: #444444; stroke-width: 0.3px; stroke-linejoin: round; stroke-linecap: round; fill: none; } text { font-family: system-ui, sans-serif; font-size: 2px; font-weight: 700; fill: #111; text-anchor: middle; dominant-baseline: central; }</style>\n`;

    let tracingPaths = '';
    let placementElements = '';
    let finalComposite = '';

    const visited = new Uint8Array(totalPixels);
    const currentFacetGrid = new Uint8Array(totalPixels);

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

        if (componentIndices.length >= config.minFacetArea) {
          const pathData = this.traceContourPath(componentIndices, currentFacetGrid, width, height);
          const labelX = sumX / componentIndices.length + 0.5;
          const labelY = sumY / componentIndices.length + 0.5;
          const fillHex = this.rgbToHex(palette[targetCluster]);

          tracingPaths += `  <path d="${pathData}" />\n`;

          const boxWidth = Math.max(1.5, (maxX - minX) * 0.2);
          const boxHeight = Math.max(1.5, (maxY - minY) * 0.2);
          placementElements += `  <path d="${pathData}" stroke="#bbbbbb" stroke-width="0.2px" />\n`;
          placementElements += `  <rect x="${labelX - boxWidth / 2}" y="${labelY - boxHeight / 2}" width="${boxWidth}" height="${boxHeight}" fill="#ff0000" opacity="0.8" />\n`;

          finalComposite += `  <g>\n`;
          finalComposite += `    <path d="${pathData}" fill="${fillHex}" opacity="0.6" />\n`;
          finalComposite += `    <path d="${pathData}" />\n`;
          finalComposite += `    <text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}">${targetCluster + 1}</text>\n`;
          finalComposite += `  </g>\n`;
        }

        for (const idx of componentIndices) {
          currentFacetGrid[idx] = 0;
        }
      }
    }

    const tracingSvg = svgHeader + styleBase + tracingPaths + `</svg>`;
    const placementSvg = svgHeader + styleBase + placementElements + `</svg>`;
    const finalSvg = svgHeader + styleBase + finalComposite + `</svg>`;

    const finalPalette = palette
      .map((rgb, index) => {
        const count = frequencyMap.get(index) || 0;
        return {
          id: index + 1,
          hex: this.rgbToHex(rgb),
          percentage: Number(((count / totalPixels) * 100).toFixed(1)),
        };
      })
      .sort((a, b) => b.percentage - a.percentage);

    return {
      width,
      height,
      quantizedDataUrl,
      reductionDataUrl,
      tracingSvg,
      placementSvg,
      finalSvg,
      palette: finalPalette,
    };
  }

  /**
   * K-Means Implementation executed purely over CIELAB space
   */
  private runKMeansLab(pixels: LAB[], k: number): LAB[] {
    const centroids: LAB[] = [];
    for (let i = 0; i < k; i++) {
      centroids.push({ ...pixels[Math.floor(Math.random() * pixels.length)] });
    }

    const maxIterations = 15;
    for (let iter = 0; iter < maxIterations; iter++) {
      const sums = Array.from({ length: k }, () => ({ l: 0, a: 0, b: 0, count: 0 }));

      for (const p of pixels) {
        let minDist = Infinity;
        let bestIndex = 0;
        for (let c = 0; c < k; c++) {
          const cent = centroids[c];
          const dist = Math.hypot(p.l - cent.l, p.a - cent.a, p.b - cent.b);
          if (dist < minDist) {
            minDist = dist;
            bestIndex = c;
          }
        }
        sums[bestIndex].l += p.l;
        sums[bestIndex].a += p.a;
        sums[bestIndex].b += p.b;
        sums[bestIndex].count++;
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
          ) {
            moved = true;
          }
          centroids[c] = { l: nl, a: na, b: nb };
        }
      }
      if (!moved) break;
    }
    return centroids;
  }

  // ==========================================================
  // COLOR SPACE CONVERSION MATH (RGB <-> XYZ <-> CIELAB)
  // ==========================================================

  private rgbToLab(color: RGB): LAB {
    // 1. Convert standard sRGB to linear RGB space
    let r = color.r / 255;
    let g = color.g / 255;
    let b = color.b / 255;

    r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
    g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
    b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;

    // 2. Linear RGB to intermediate XYZ space using D65 illuminant
    r *= 100;
    g *= 100;
    b *= 100;
    const x = r * 0.4124 + g * 0.3576 + b * 0.1805;
    const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const z = r * 0.0193 + g * 0.1192 + b * 0.9505;

    // 3. XYZ to CIELAB space mapping
    // Reference white points for standard daylight D65
    const refX = 95.047;
    const refY = 100.0;
    const refZ = 108.883;
    let px = x / refX;
    let py = y / refY;
    let pz = z / refZ;

    px = px > 0.008856 ? Math.pow(px, 1 / 3) : 7.787 * px + 16 / 116;
    py = py > 0.008856 ? Math.pow(py, 1 / 3) : 7.787 * py + 16 / 116;
    pz = pz > 0.008856 ? Math.pow(pz, 1 / 3) : 7.787 * pz + 16 / 116;

    return {
      l: 116 * py - 16,
      a: 500 * (px - py),
      b: 200 * (py - pz),
    };
  }

  private labToRgb(lab: LAB): RGB {
    // 1. CIELAB to XYZ space
    let py = (lab.l + 16) / 116;
    let px = lab.a / 500 + py;
    let pz = py - lab.b / 200;

    const py3 = Math.pow(py, 3);
    const px3 = Math.pow(px, 3);
    const pz3 = Math.pow(pz, 3);
    px = px3 > 0.008856 ? px3 : (px - 16 / 116) / 7.787;
    py = py3 > 0.008856 ? py3 : (py - 16 / 116) / 7.787;
    pz = pz3 > 0.008856 ? pz3 : (pz - 16 / 116) / 7.787;

    const refX = 95.047;
    const refY = 100.0;
    const refZ = 108.883;
    const x = (px * refX) / 100;
    const y = (py * refY) / 100;
    const z = (pz * refZ) / 100;

    // 2. XYZ to linear sRGB mapping
    let r = x * 3.2406 + y * -1.5372 + z * -0.4986;
    let g = x * -0.9689 + y * 1.8758 + z * 0.0415;
    let b = x * 0.0557 + y * -0.204 + z * 1.057;

    // 3. Re-apply standard gamma transformation curves
    r = r > 0.0031308 ? 1.055 * Math.pow(r, 1 / 2.4) - 0.055 : 12.92 * r;
    g = g > 0.0031308 ? 1.055 * Math.pow(g, 1 / 2.4) - 0.055 : 12.92 * g;
    b = b > 0.0031308 ? 1.055 * Math.pow(b, 1 / 2.4) - 0.055 : 12.92 * b;

    return {
      r: Math.min(255, Math.max(0, Math.round(r * 255))),
      g: Math.min(255, Math.max(0, Math.round(g * 255))),
      b: Math.min(255, Math.max(0, Math.round(b * 255))),
    };
  }

  // Standard serialization trace helpers
  private generateStageDataUrl(
    labels: Int32Array,
    palette: RGB[],
    width: number,
    height: number,
  ): string {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    const imgData = ctx.createImageData(width, height);
    const d = imgData.data;

    for (let i = 0; i < labels.length; i++) {
      const color = palette[labels[i]];
      const offset = i * 4;
      d[offset] = color.r;
      d[offset + 1] = color.g;
      d[offset + 2] = color.b;
      d[offset + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas.toDataURL();
  }

  private generateReductionStage(
    labels: Int32Array,
    palette: RGB[],
    width: number,
    height: number,
    minArea: number,
  ): string {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    const imgData = ctx.createImageData(width, height);
    const d = imgData.data;
    const totalPixels = width * height;

    const visited = new Uint8Array(totalPixels);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (visited[idx]) continue;

        const target = labels[idx];
        const comp: number[] = [];
        const q: number[] = [idx];
        visited[idx] = 1;

        while (q.length > 0) {
          const curr = q.pop()!;
          comp.push(curr);
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
              if (!visited[nIdx] && labels[nIdx] === target) {
                visited[nIdx] = 1;
                q.push(nIdx);
              }
            }
          }
        }

        const isNoise = comp.length < minArea;
        for (const ci of comp) {
          const offset = ci * 4;
          if (isNoise) {
            d[offset] = 255;
            d[offset + 1] = 255;
            d[offset + 2] = 255;
          } else {
            const color = palette[target];
            d[offset] = color.r;
            d[offset + 1] = color.g;
            d[offset + 2] = color.b;
          }
          d[offset + 3] = 255;
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas.toDataURL();
  }

  private traceContourPath(
    indices: number[],
    facetMembership: Uint8Array,
    width: number,
    height: number,
  ): string {
    let pathString = '';
    for (const idx of indices) {
      const x = idx % width;
      const y = Math.floor(idx / width);
      const isMember = (nx: number, ny: number) => {
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) return false;
        return facetMembership[ny * width + nx] === 1;
      };
      if (!isMember(x, y - 1)) pathString += `M ${x} ${y} L ${x + 1} ${y} `;
      if (!isMember(x + 1, y)) pathString += `M ${x + 1} ${y} L ${x + 1} ${y + 1} `;
      if (!isMember(x, y + 1)) pathString += `M ${x + 1} ${y + 1} L ${x} ${y + 1} `;
      if (!isMember(x - 1, y)) pathString += `M ${x} ${y + 1} L ${x} ${y} `;
    }
    return pathString.trim();
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
    const toHex = (n: number) => n.toString(16).padStart(2, '0');
    return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
  }
}
