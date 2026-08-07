import { Routes } from '@angular/router';
import { DashboardComponent } from './pages/dashboard/dashboard.component';
import { JsonViewPageComponent } from './pages/json-view/json-view-page.component';

export const routes: Routes = [
  { path: '', component: DashboardComponent },
  { path: 'view', component: JsonViewPageComponent },
];
