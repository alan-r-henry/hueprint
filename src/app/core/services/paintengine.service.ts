import { Injectable } from '@angular/core';
import { GeneratorConfig, GenerationResult, RGB } from '../models/types';

@Injectable({
  providedIn: 'root'
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

    const pixels: RGB[] = [];
    for (let i = 0; i < data.length; i += 4) {
      pixels.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
    }

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

    let svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="100%">\n`;
    svgString += `<style>path { stroke: #b0b0b0; stroke-width: 0.5px; fill: none; } text { font-family: sans-serif; font-size: 3px; fill: #444; text-anchor: middle; dominant-baseline: middle; }</style>\n`;

    const visited = new Uint8Array(totalPixels);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (visited[idx]) continue;

        const targetCluster = labels[idx];
        const componentIndices: number[] = [];
        const queue: number[] = [idx];
        visited[idx] = 1;

        let minX = x, maxX = x, minY = y, maxY = y;

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
            { nx: cx, ny: cy - 1 }
          ];

          for (const n of neighbors) {
            if (n.nx >= 0 && n.nx < width && n.ny >= 0 && n.ny < height) {
              const nIdx = n.ny * width + n.nx;
              if (!visited[nIdx] && labels[nIdx] === targetCluster) {
                visited[nIdx] = 1;
                queue.push(nIdx);
              }
            }
          }
        }

        if (componentIndices.length >= config.minFacetArea) {
          const pathData = `M ${minX} ${minY} L ${maxX} ${minY} L ${maxX} ${maxY} L ${minX} ${maxY} Z`;
          const centerX = (minX + maxX) / 2;
          const centerY = (minY + maxY) / 2;

          svgString += `  <g>\n`;
          svgString += `    <path d="${pathData}" />\n`;
          svgString += `    <text x="${centerX}" y="${centerY}">${targetCluster + 1}</text>\n`;
          svgString += `  </g>\n`;
        }
      }
    }
    svgString += `</svg>`;

    const finalPalette = palette.map((rgb, index) => {
      const count = frequencyMap.get(index) || 0;
      return {
        id: index + 1,
        hex: this.rgbToHex(rgb),
        percentage: Number(((count / totalPixels) * 100).toFixed(1))
      };
    }).sort((a, b) => b.percentage - a.percentage);

    return { svgContent: svgString, palette: finalPalette };
  }

  private runKMeans(pixels: RGB[], k: number): RGB[] {
    const centroids: RGB[] = [];
    for (let i = 0; i < k; i++) {
      const randPixel = pixels[Math.floor(Math.random() * pixels.length)];
      centroids.push({ ...randPixel });
    }

    const maxIterations = 10;
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