import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { DbWindowHostComponent } from './components/db-capture/db-window-host.component';
import { LowDiskBannerComponent } from './components/low-disk-banner/low-disk-banner.component';
import { ReturnPointHostComponent } from './components/board/return-point-host/return-point-host.component';

import { ConsentDialogComponent } from './components/consent-dialog/consent-dialog.component';
import { AnswersImportComponent } from './components/board/answers-import/answers-import.component';
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, DbWindowHostComponent, LowDiskBannerComponent, ReturnPointHostComponent, ConsentDialogComponent, AnswersImportComponent],
  templateUrl: './app.component.html',
})
export class AppComponent {}
