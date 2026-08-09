import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ThemePickerComponent } from '../../components/theme-picker/theme-picker.component';

/** First tab-nav shell in the app - "Live Calls" (the original dashboard) and "Session Cycles" render as children below this same nav bar. The /view route deliberately stays outside this layout (opened via window.open, wants the full page to itself). The theme picker lives here rather than in `HeaderComponent` since it's app-wide, not per-page. */
@Component({
  selector: 'app-main-layout',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet, ThemePickerComponent],
  templateUrl: './main-layout.component.html',
})
export class MainLayoutComponent {}
