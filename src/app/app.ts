import { Component } from '@angular/core';
import { GeneratorComponent } from './features/generator/generator';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [GeneratorComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {}