import { Component } from '@angular/core';
import { GeneratorComponent } from './features/generator/generator';

@Component({
  selector: 'app-root',
  imports: [GeneratorComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {}