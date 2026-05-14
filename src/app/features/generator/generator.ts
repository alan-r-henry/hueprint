// src/app/features/generator/generator.component.ts

import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { GenerationResult, GeneratorConfig } from '../../core/models/types';
import { PaintEngineService } from '../../core/services/paint-engine.service';

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

  // Active Stage Navigation Pointers
  activeTab = signal<'quantized' | 'reduction' | 'tracing' | 'segments' | 'placement' | 'final'>(
    'final',
  );

  // Sanitized string wrappers
  safeTracingSvg = signal<SafeHtml | null>(null);
  safeSegmentSvg = signal<SafeHtml | null>(null); // <-- Added safe binder
  safePlacementSvg = signal<SafeHtml | null>(null);
  safeFinalSvg = signal<SafeHtml | null>(null);

  config = signal<GeneratorConfig>({
    clusterCount: 8,
    minFacetArea: 10,
    maxImageDimension: 600,
  });

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      this.selectedFile.set(file);
      this.resultData.set(null);
      const reader = new FileReader();
      reader.onload = (e) => this.previewUrl.set(e.target?.result as string);
      reader.readAsDataURL(file);
    }
  }

  updateConfig(key: keyof GeneratorConfig, event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.config.update((curr) => ({ ...curr, [key]: value }));
  }

  setActiveTab(
    tab: 'quantized' | 'reduction' | 'tracing' | 'segments' | 'placement' | 'final',
  ): void {
    this.activeTab.set(tab);
  }
  async generateCanvas(): Promise<void> {
    const file = this.selectedFile();
    if (!file) return;
    this.isProcessing.set(true);
    try {
      const res = await this.paintEngine.processImage(file, this.config());
      this.resultData.set(res);
      this.safeTracingSvg.set(this.sanitizer.bypassSecurityTrustHtml(res.tracingSvg));
      this.safeSegmentSvg.set(this.sanitizer.bypassSecurityTrustHtml(res.segmentSvg)); // <-- Map output pipeline layer
      this.safePlacementSvg.set(this.sanitizer.bypassSecurityTrustHtml(res.placementSvg));
      this.safeFinalSvg.set(this.sanitizer.bypassSecurityTrustHtml(res.finalSvg));
      this.activeTab.set('final');
    } catch (error) {
      console.error('Generation Error:', error);
      alert('Processing overload. Execution threads scaled down.');
    } finally {
      this.isProcessing.set(false);
    }
  }

  downloadSVG(): void {
    const data = this.resultData();
    if (!data) return;
    const blob = new Blob([data.finalSvg], { type: 'image/svg+xml' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'paint-by-numbers-master.svg';
    a.click();
    window.URL.revokeObjectURL(url);
  }
}
