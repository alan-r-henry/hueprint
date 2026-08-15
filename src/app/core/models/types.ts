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

  /**
   * Colour of the facet outlines on the printable template.
   *
   * Dark guides are easy to follow on screen but can show through the finished paint, so this is
   * adjustable: lighter values print faintly enough to disappear once painted over.
   */
  borderColor: string;

  /** Colour of the facet numbers. Same trade-off as {@link borderColor}. */
  labelColor: string;

  /**
   * Outline thickness, in image pixels at the downsampled size.
   *
   * Thin lines print crisply but can be hard to follow on a busy template; thick lines are easier
   * to paint up to but swallow small facets. Also sets the width of the matching stroke on each
   * colour wash, so a painted facet still covers the space its outline occupied.
   */
  borderWidth: number;
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
