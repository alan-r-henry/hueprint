// src/app/features/generator/generator.ts

import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { GenerationResult, GeneratorConfig } from '../../core/models/types';
import { PaintEngineService } from '../../core/services/paint-engine.service';

/** The pipeline stages a user can inspect, in the order they are produced. */
export type StageTab = 'quantized' | 'reduction' | 'tracing' | 'segments' | 'placement' | 'final';

@Component({
  selector: 'app-generator',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './generator.html',
  styleUrls: ['./generator.scss'],
})
export class GeneratorComponent {
  private paintEngine = inject(PaintEngineService);
  private sanitizer = inject(DomSanitizer);

  selectedFile = signal<File | null>(null);
  previewUrl = signal<string | null>(null);
  isProcessing = signal<boolean>(false);
  resultData = signal<GenerationResult | null>(null);

  /** Surfaced in the viewport when a run fails, instead of a blocking alert(). */
  errorMessage = signal<string | null>(null);

  activeTab = signal<StageTab>('final');

  /**
   * Freezes the painting animation on the final output.
   *
   * Set while the download control is hovered or keyboard-focused, so the template holds still
   * while the user is reaching for it. Focus is tracked as well as hover so the behaviour is
   * reachable without a mouse.
   */
  isPaintAnimationPaused = signal(false);

  /** Host of the final-output SVG, used to rewind the painting animation. */
  private finalViewport = viewChild<ElementRef<HTMLElement>>('finalViewport');

  config = signal<GeneratorConfig>({
    clusterCount: 8,
    minFacetArea: 10,
    maxImageDimension: 600,
    borderColor: '#444444',
    labelColor: '#111111',
  });

  safeTracingSvg = computed(() => this.trustSvg(this.resultData()?.tracingSvg));
  safeSegmentSvg = computed(() => this.trustSvg(this.resultData()?.segmentSvg));
  safePlacementSvg = computed(() => this.trustSvg(this.resultData()?.placementSvg));

  /**
   * The final composite with the painting animation stylesheet appended.
   *
   * The animation is injected here rather than inside the engine's `finalSvg` so that the string
   * handed to downloadSVG() stays static and fully coloured — an animated file would be wrong for
   * a template that is meant to be printed.
   */
  safeFinalSvg = computed(() => {
    const result = this.resultData();
    if (!result) return null;

    const animationCss = this.paintEngine.buildPaintAnimationCss(result.palette);
    return this.trustSvg(result.finalSvg.replace('</svg>', `${animationCss}</svg>`));
  });

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const file = input.files[0];
    this.selectedFile.set(file);
    this.resultData.set(null);
    this.errorMessage.set(null);

    const reader = new FileReader();
    reader.onload = (e) => this.previewUrl.set(e.target?.result as string);
    reader.readAsDataURL(file);
  }

  /** Updates a numeric setting from a range or number input. */
  updateConfig(key: 'clusterCount' | 'minFacetArea' | 'maxImageDimension', event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.config.update((curr) => ({ ...curr, [key]: value }));
  }

  /** Updates a guide colour from a colour input. */
  updateConfigColor(key: 'borderColor' | 'labelColor', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.config.update((curr) => ({ ...curr, [key]: value }));
  }

  setActiveTab(tab: StageTab): void {
    this.activeTab.set(tab);
  }

  /**
   * Drives the painting animation from the download control's hover/focus state.
   *
   * Both directions rewind to the start of the cycle, which is the unpainted template — only the
   * play state differs. Hovering therefore clears the artwork and holds it empty, showing the bare
   * outlines and numbers; leaving restarts the sequence from the top so the next viewer sees the
   * whole thing rather than joining midway through a wipe.
   */
  setPaintAnimationPaused(paused: boolean): void {
    this.isPaintAnimationPaused.set(paused);
    this.rewindPaintAnimation();
  }

  /**
   * Sends every colour wash back to the start of its cycle, where nothing is painted yet.
   *
   * The timeline is reset through the Web Animations API rather than by re-rendering the SVG.
   * Re-injecting the markup would force the browser to re-parse every path on each hover, which is
   * wasteful on a template with hundreds of facets.
   */
  private rewindPaintAnimation(): void {
    const host = this.finalViewport()?.nativeElement;
    if (!host) return;

    // Washes, outlines and labels are all on the same timeline and must rewind together.
    const animated = host.querySelectorAll(
      `.${PaintEngineService.FILL_CLASS}, .${PaintEngineService.OUTLINE_CLASS}, .${PaintEngineService.LABEL_CLASS}`,
    );

    for (const layer of animated) {
      for (const animation of layer.getAnimations()) {
        animation.currentTime = 0;
      }
    }
  }

  async generateCanvas(): Promise<void> {
    const file = this.selectedFile();
    if (!file) return;

    this.isProcessing.set(true);
    this.errorMessage.set(null);

    try {
      const res = await this.paintEngine.processImage(file, this.config());
      this.resultData.set(res);
      this.activeTab.set('final');
    } catch (error) {
      console.error('Generation Error:', error);
      this.errorMessage.set(
        'Could not process that image. Try a smaller file, or lower the colour count.',
      );
    } finally {
      this.isProcessing.set(false);
    }
  }

  downloadSVG(): void {
    const data = this.resultData();
    if (!data) return;

    // Deliberately the engine's untouched output: static, fully coloured, print-ready.
    const blob = new Blob([data.finalSvg], { type: 'image/svg+xml' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'paint-by-numbers-master.svg';
    a.click();
    window.URL.revokeObjectURL(url);
  }

  /**
   * Marks generated SVG markup as trusted for [innerHTML].
   *
   * This is safe because every string involved is built by PaintEngineService from numeric path
   * data and palette values computed off the image buffer. No user-supplied text — including the
   * filename — is ever interpolated into it.
   */
  private trustSvg(markup: string | undefined): SafeHtml | null {
    return markup ? this.sanitizer.bypassSecurityTrustHtml(markup) : null;
  }
}
