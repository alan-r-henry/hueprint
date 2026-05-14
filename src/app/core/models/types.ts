// src/app/core/models/types.ts

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface GeneratorConfig {
  clusterCount: number;
  minFacetArea: number;
  maxImageDimension: number;
}

export interface GenerationResult {
  width: number;
  height: number;
  // 1. Quantized Canvas Stage DataURL
  quantizedDataUrl: string;
  // 2. Facet Reduction Map DataURL
  reductionDataUrl: string;
  // 3. Raw SVG Traced Outlines String
  tracingSvg: string;
  // 4. Bounding Box & Centroid Inaccessibility SVG Map
  placementSvg: string;
  // 5. Final Master SVG String
  finalSvg: string;
  palette: { id: number; hex: string; percentage: number }[];
}
