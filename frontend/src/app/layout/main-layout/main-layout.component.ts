import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

/** First tab-nav shell in the app - "Live Calls" (the original dashboard) and "Session Cycles" render as children below this same nav bar. The /view route deliberately stays outside this layout (opened via window.open, wants the full page to itself). */
@Component({
  selector: 'app-main-layout',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './main-layout.component.html',
})
export class MainLayoutComponent {}
