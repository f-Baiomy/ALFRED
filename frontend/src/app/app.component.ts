import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { DbWindowHostComponent } from './components/db-capture/db-window-host.component';
import { LowDiskBannerComponent } from './components/low-disk-banner/low-disk-banner.component';
import { ReturnPointHostComponent } from './components/board/return-point-host/return-point-host.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, DbWindowHostComponent, LowDiskBannerComponent, ReturnPointHostComponent],
  templateUrl: './app.component.html',
})
export class AppComponent {}
