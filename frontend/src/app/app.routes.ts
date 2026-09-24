import { Routes } from '@angular/router';
import { MainLayoutComponent } from './layout/main-layout/main-layout.component';
import { DashboardComponent } from './pages/dashboard/dashboard.component';
import { InterceptionComponent } from './pages/interception/interception.component';
import { EditViewPageComponent } from './pages/edit-view/edit-view-page.component';
import { JsonViewPageComponent } from './pages/json-view/json-view-page.component';
import { ProfilesListComponent } from './pages/profiles-list/profiles-list.component';
import { SessionCyclesListComponent } from './pages/session-cycles-list/session-cycles-list.component';
import { SessionCycleDetailComponent } from './pages/session-cycle-detail/session-cycle-detail.component';
import { SettingsComponent } from './pages/settings/settings.component';

export const routes: Routes = [
  {
    path: '',
    component: MainLayoutComponent,
    children: [
      { path: '', component: DashboardComponent },
      { path: 'cycles', component: SessionCyclesListComponent },
      { path: 'cycles/:id', component: SessionCycleDetailComponent },
      { path: 'profiles', component: ProfilesListComponent },
      { path: 'interception', component: InterceptionComponent },
      { path: 'settings', component: SettingsComponent },
    ],
  },
  // Stays outside the tab-nav layout - opened via window.open, wants the full page to itself.
  { path: 'view', component: JsonViewPageComponent },
  // The big-tab body/header editor (EditTabService) - outside the layout for the same reason.
  { path: 'edit', component: EditViewPageComponent },
];
