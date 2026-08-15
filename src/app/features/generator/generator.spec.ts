import { ComponentFixture, TestBed } from '@angular/core/testing';

import { GeneratorComponent } from './generator';

describe('GeneratorComponent', () => {
  let component: GeneratorComponent;
  let fixture: ComponentFixture<GeneratorComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GeneratorComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(GeneratorComponent);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should start with the default generator config', () => {
    expect(component.config()).toEqual({
      clusterCount: 8,
      minFacetArea: 10,
      maxImageDimension: 600,
      borderColor: '#444444',
      labelColor: '#111111',
    });
  });

  it('should update a guide colour without disturbing the other settings', () => {
    const event = { target: { value: '#cccccc' } } as unknown as Event;
    component.updateConfigColor('labelColor', event);

    expect(component.config().labelColor).toBe('#cccccc');
    expect(component.config().borderColor).toBe('#444444');
    expect(component.config().clusterCount).toBe(8);
  });

  it('should not be processing before a file is chosen', () => {
    expect(component.selectedFile()).toBeNull();
    expect(component.isProcessing()).toBe(false);
    expect(component.resultData()).toBeNull();
  });
});
