import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { GenerationResult, GeneratorConfig } from '../../core/models/types';
import { PaintEngineService } from '../../core/services/paintengine.service';

@Component({
  selector: 'app-generator',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './generator.html',
  styleUrls: ['./generator.scss']
})
export class GeneratorComponent {
  private paintEngine = inject(PaintEngineService);
  private sanitizer = inject(DomSanitizer);

  selectedFile = signal<File | null>(null);
  previewUrl = signal<string | null>(null);
  isProcessing = signal<boolean>(false);
  resultData = signal<GenerationResult | null>(null);
  safeSvgContent = signal<SafeHtml | null>(null);

  config = signal<GeneratorConfig>({
    clusterCount: 8,
    minFacetArea: 10,
    maxImageDimension: 600
  });

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      this.selectedFile.set(file);
      this.resultData.set(null);
      this.safeSvgContent.set(null);

      const reader = new FileReader();
      reader.onload = (e) => this.previewUrl.set(e.target?.result as string);
      reader.readAsDataURL(file);
    }
  }

  updateConfig(key: keyof GeneratorConfig, event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.config.update(curr => ({ ...curr, [key]: value }));
  }

  async generateCanvas(): Promise<void> {
    const file = this.selectedFile();
    if (!file) return;

    this.isProcessing.set(true);
    try {
      const res = await this.paintEngine.processImage(file, this.config());
      this.resultData.set(res);
      this.safeSvgContent.set(this.sanitizer.bypassSecurityTrustHtml(res.svgContent));
    } catch (error) {
      console.error('Generation Error:', error);
      alert('Failed to process image matrix. Try an image with a smaller footprint.');
    } finally {
      this.isProcessing.set(false);
    }
  }

  downloadSVG(): void {
    const data = this.resultData();
    if (!data) return;

    const blob = new Blob([data.svgContent], { type: 'image/svg+xml' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'paint-by-numbers-canvas.svg';
    a.click();
    window.URL.revokeObjectURL(url);
  }
}