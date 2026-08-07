import { Routes } from '@angular/router';
import { DashboardComponent } from './pages/dashboard/dashboard.component';
import { JsonEditorPageComponent } from './pages/json-editor/json-editor-page.component';

export const routes: Routes = [
  { path: '', component: DashboardComponent },
  { path: 'editor', component: JsonEditorPageComponent },
];
