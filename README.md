# Hueprint

Turn any photograph into a printable paint-by-numbers template — colour-clustered, outlined, numbered, and exported as clean vector SVG. Everything runs in the browser; no image ever leaves your machine.

[![CI](https://github.com/alan-r-henry/paint-by-numbers/actions/workflows/ci.yml/badge.svg)](https://github.com/alan-r-henry/paint-by-numbers/actions/workflows/ci.yml)
[![Deploy](https://github.com/alan-r-henry/paint-by-numbers/actions/workflows/deploy.yml/badge.svg)](https://github.com/alan-r-henry/paint-by-numbers/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Angular](https://img.shields.io/badge/Angular-21-dd0031.svg)](https://angular.dev)

**[▶ Try it live](https://alan-r-henry.github.io/paint-by-numbers/)**

---

## What it does

Upload an image and the engine reduces it to a small, paintable palette, then works out where the outlines and numbers belong:

1. **Downsample** — the image is scaled to a bounded dimension so clustering stays responsive.
2. **Perceptual quantization** — pixels are converted from RGB into [CIELAB](https://en.wikipedia.org/wiki/CIELAB_color_space) and clustered with k-means. LAB is used rather than RGB because Euclidean distance in LAB tracks _perceived_ colour difference, so the resulting palette looks right to the eye instead of merely being numerically close.
3. **Facet reduction** — connected regions smaller than a threshold are absorbed into their neighbours, removing the speckle that makes a template unpaintable.
4. **Border tracing** — each remaining region is extracted as a connected component and traced into a path.
5. **Wavelet smoothing** — the raw integer-step outlines are smoothed into flowing segments.
6. **Label placement** — a number is positioned inside each region, scaled to the space available.

The result is a layered SVG you can print and paint.

## Inspecting the pipeline

Every intermediate stage is exposed as its own tab, so you can see exactly what each step did:

| Stage         | What you're looking at                         |
| ------------- | ---------------------------------------------- |
| **Quantized** | The image reduced to the clustered palette     |
| **Reduction** | The same image after small facets are absorbed |
| **Tracing**   | Raw integer-step region outlines               |
| **Segments**  | Outlines after wavelet smoothing               |
| **Placement** | Where the numbers land                         |
| **Final**     | The composited, printable template             |

This makes the app useful as a teaching tool as much as a generator — the failure modes of each algorithm are visible rather than hidden behind a single output.

### The final view paints itself

The **Final** tab loops through the template being painted: it rests unpainted, then fills one colour every half second starting with the largest area, dropping each region's outline and number as its colour lands, so finished areas read as solid paint. Once the picture is complete it holds for five seconds and starts over.

Hovering the download button clears it back to the empty template and holds it there, so you can see what you are about to save. The animation is generated CSS driven entirely by the browser, and it honours `prefers-reduced-motion`. It is applied to the on-screen copy only — **the downloaded SVG is static and keeps its outlines and numbers**, as a printable template must.

## Controls

| Parameter           | Range | Default | Effect                                                                                         |
| ------------------- | ----- | ------- | ---------------------------------------------------------------------------------------------- |
| `clusterCount`      | 2–24  | 8       | Number of colours in the final palette. Fewer colours means a simpler, more abstract painting. |
| `minFacetArea`      | 1–100 | 10      | Smallest region kept, in pixels. Raise it to remove fiddly detail.                             |
| `maxImageDimension` | —     | 600     | Longest edge after downsampling. Higher retains detail but costs processing time.              |
| `borderColor`       | —     | #444444 | Colour of the facet outlines. Lighter values disappear under the finished paint.               |
| `labelColor`        | —     | #111111 | Colour of the facet numbers. Same trade-off as the borders.                                    |

Colours are numbered by area: **1 is always the largest region**, 2 the next, and so on.

Finished templates export via **Download SVG** as `hueprint-template.svg`.

## Running locally

Requires Node.js 20 or newer.

```bash
git clone https://github.com/alan-r-henry/paint-by-numbers.git
```

```bash
npm ci
```

```bash
npm start
```

Then open <http://localhost:4200/>.

### Other commands

Production build:

```bash
npm run build
```

Unit tests:

```bash
npm test -- --watch=false
```

Format the codebase:

```bash
npx prettier --write .
```

## Project structure

```
src/app/
├── app.ts                               # Root standalone component
├── core/
│   ├── models/types.ts                  # RGB, GeneratorConfig, GenerationResult
│   └── services/paint-engine.service.ts # The whole image pipeline
└── features/generator/                  # Upload UI, controls, stage viewer
```

The engine is deliberately kept framework-agnostic: `PaintEngineService.processImage(file, config)` takes a `File` and returns a `GenerationResult`, with no Angular-specific types crossing the boundary. It could be lifted into a web worker or a different framework without modification.

## Tech stack

Angular 21 (standalone components, signals) · TypeScript 5.9 · Vitest · SCSS · Canvas 2D API

## Licence

[MIT](LICENSE) © Alan Henry
