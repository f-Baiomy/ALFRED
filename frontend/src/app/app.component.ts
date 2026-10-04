import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { DbWindowHostComponent } from './components/db-capture/db-window-host.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, DbWindowHostComponent],
  templateUrl: './app.component.html',
})
export class AppComponent {}
