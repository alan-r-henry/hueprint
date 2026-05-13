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
  svgContent: string;
  palette: { id: number; hex: string; percentage: number }[];
}