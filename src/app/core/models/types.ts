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
  quantizedDataUrl: string;
  reductionDataUrl: string;
  // Raw integer-step tracing view
  tracingSvg: string;
  // Smoothed Wavelet border segments view
  segmentSvg: string;
  placementSvg: string;
  finalSvg: string;
  palette: { id: number; hex: string; percentage: number }[];
}
