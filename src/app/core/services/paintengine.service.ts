import { Injectable } from '@angular/core';
import { GeneratorConfig, GenerationResult, RGB } from '../models/types';

@Injectable({
  providedIn: 'root',
})
export class PaintEngineService {
  public async processImage(file: File, config: GeneratorConfig): Promise<GenerationResult> {
    const img = await this.loadImage(file);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Failed to get 2D context');

    // 1. Maintain aspect ratio while strictly enforcing maximum dimension constraints
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

    // 2. Extract pixel RGB array
    const pixels: RGB[] = [];
    for (let i = 0; i < data.length; i += 4) {
      pixels.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
    }

    // 3. Execute K-Means Color Clustering
    const palette = this.runKMeans(pixels, config.clusterCount);
    const labels = new Int32Array(totalPixels);
    const frequencyMap = new Map<number, number>();

    for (let i = 0; i < pixels.length; i++) {
      let minDist = Infinity;
      let bestCluster = 0;
      const p = pixels[i];

      for (let c = 0; c < palette.length; c++) {
        const centroid = palette[c];
        const dist = Math.hypot(p.r - centroid.r, p.g - centroid.g, p.b - centroid.b);
        if (dist < minDist) {
          minDist = dist;
          bestCluster = c;
        }
      }
      labels[i] = bestCluster;
      frequencyMap.set(bestCluster, (frequencyMap.get(bestCluster) || 0) + 1);
    }

    // 4. Trace Exact Geometry Borders
    let svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="100%">\n`;
    svgString += `<style>path { stroke: #888888; stroke-width: 0.4px; stroke-linejoin: round; stroke-linecap: round; fill: none; } text { font-family: system-ui, sans-serif; font-size: 2.5px; font-weight: 600; fill: #222; text-anchor: middle; dominant-baseline: central; }</style>\n`;

    const visited = new Uint8Array(totalPixels);
    // Temporary lookup grid used to quickly map active facet membership during edge analysis
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

        // Extract connected component via flood-fill
        while (queue.length > 0) {
          const curr = queue.pop()!;
          componentIndices.push(curr);

          const cx = curr % width;
          const cy = Math.floor(curr / width);

          sumX += cx;
          sumY += cy;

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

        // Apply topological filtering (Pruning small noise areas)
        if (componentIndices.length >= config.minFacetArea) {
          // Generate precise vector contour path string for the facet
          const pathData = this.traceContourPath(componentIndices, currentFacetGrid, width, height);

          // Place label near the visual centroid mass of the extracted component
          const labelX = sumX / componentIndices.length + 0.5;
          const labelY = sumY / componentIndices.length + 0.5;

          svgString += `  <g>\n`;
          svgString += `    <path d="${pathData}" />\n`;
          svgString += `    <text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}">${targetCluster + 1}</text>\n`;
          svgString += `  </g>\n`;
        }

        // Reset the lookup grid cleanly for the next shape extraction
        for (const idx of componentIndices) {
          currentFacetGrid[idx] = 0;
        }
      }
    }
    svgString += `</svg>`;

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

    return { svgContent: svgString, palette: finalPalette };
  }

  /**
   * Scans pixel boundaries of a component to extract clean SVG contour paths.
   */
  private traceContourPath(
    indices: number[],
    facetMembership: Uint8Array,
    width: number,
    height: number,
  ): string {
    let pathString = '';

    // Map boundary segments to avoid drawing internal solid blocks
    for (const idx of indices) {
      const x = idx % width;
      const y = Math.floor(idx / width);

      const isMember = (nx: number, ny: number) => {
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) return false;
        return facetMembership[ny * width + nx] === 1;
      };

      // Top edge
      if (!isMember(x, y - 1)) {
        pathString += `M ${x} ${y} L ${x + 1} ${y} `;
      }
      // Right edge
      if (!isMember(x + 1, y)) {
        pathString += `M ${x + 1} ${y} L ${x + 1} ${y + 1} `;
      }
      // Bottom edge
      if (!isMember(x, y + 1)) {
        pathString += `M ${x + 1} ${y + 1} L ${x} ${y + 1} `;
      }
      // Left edge
      if (!isMember(x - 1, y)) {
        pathString += `M ${x} ${y + 1} L ${x} ${y} `;
      }
    }

    return pathString.trim();
  }

  private runKMeans(pixels: RGB[], k: number): RGB[] {
    const centroids: RGB[] = [];
    for (let i = 0; i < k; i++) {
      const randPixel = pixels[Math.floor(Math.random() * pixels.length)];
      centroids.push({ ...randPixel });
    }

    const maxIterations = 12;
    for (let iter = 0; iter < maxIterations; iter++) {
      const sums = Array.from({ length: k }, () => ({ r: 0, g: 0, b: 0, count: 0 }));

      for (const p of pixels) {
        let minDist = Infinity;
        let bestIndex = 0;
        for (let c = 0; c < k; c++) {
          const cent = centroids[c];
          const dist = Math.hypot(p.r - cent.r, p.g - cent.g, p.b - cent.b);
          if (dist < minDist) {
            minDist = dist;
            bestIndex = c;
          }
        }
        sums[bestIndex].r += p.r;
        sums[bestIndex].g += p.g;
        sums[bestIndex].b += p.b;
        sums[bestIndex].count++;
      }

      let moved = false;
      for (let c = 0; c < k; c++) {
        if (sums[c].count > 0) {
          const newR = Math.round(sums[c].r / sums[c].count);
          const newG = Math.round(sums[c].g / sums[c].count);
          const newB = Math.round(sums[c].b / sums[c].count);
          if (centroids[c].r !== newR || centroids[c].g !== newG || centroids[c].b !== newB) {
            moved = true;
          }
          centroids[c] = { r: newR, g: newG, b: newB };
        }
      }
      if (!moved) break;
    }
    return centroids;
  }

  private loadImage(file: File): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = e.target?.result as string;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  private rgbToHex(color: RGB): string {
    const toHex = (n: number) => n.toString(16).padStart(2, '0');
    return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
  }
}
