import { Routes } from '@angular/router';
import { MainLayoutComponent } from './layout/main-layout/main-layout.component';
import { reliveUnsavedChangesGuard } from './pages/relive-cycle/relive-unsaved-changes.guard';

export const routes: Routes = [
  {
    path: '',
    component: MainLayoutComponent,
    children: [
      // Every page is lazy, Live Calls too: the first download is the shell (core, router, layout), and the landing
      // page's own chunk follows at once - the call card, waterfall and panels kept the shell over its size budget.
      { path: '', loadComponent: () => import('./pages/dashboard/dashboard.component').then((m) => m.DashboardComponent) },
      { path: 'cycles', loadComponent: () => import('./pages/session-cycles-list/session-cycles-list.component').then((m) => m.SessionCyclesListComponent) },
      { path: 'board', loadComponent: () => import('./pages/board/board-page.component').then((m) => m.BoardPageComponent) },
      // specs/027: the team's tracker (Azure DevOps first), read from Alfred's shared cache. `team` is no backend prefix.
      { path: 'team', loadComponent: () => import('./pages/team/team-page.component').then((m) => m.TeamPageComponent) },
      { path: 'cycles/:id', loadComponent: () => import('./pages/session-cycle-detail/session-cycle-detail.component').then((m) => m.SessionCycleDetailComponent) },
      { path: 'profiles', loadComponent: () => import('./pages/profiles-list/profiles-list.component').then((m) => m.ProfilesListComponent) },
      // Lazy: the rule editor and its action panels are the heaviest page and most visits never open it.
      { path: 'interception', loadComponent: () => import('./pages/interception/interception.component').then((m) => m.InterceptionComponent) },
      { path: 'relive', loadComponent: () => import('./pages/relive/relive-list.component').then((m) => m.ReliveListComponent) },
      {
        path: 'relive/:id',
        loadComponent: () => import('./pages/relive-cycle/relive-cycle.component').then((m) => m.ReliveCycleComponent),
        canDeactivate: [reliveUnsavedChangesGuard],
      },
      // Logs Explorer (specs/004-logs-explorer): sources, the new-source wizard, the structure editor, the explorer.
      { path: 'logs', loadComponent: () => import('./pages/logs/logs-sources.component').then((m) => m.LogsSourcesComponent) },
      { path: 'logs/new', loadComponent: () => import('./pages/logs/log-source-wizard.component').then((m) => m.LogSourceWizardComponent) },
      { path: 'logs/:id/sessions', loadComponent: () => import('./pages/logs/log-sessions-page.component').then((m) => m.LogSessionsPageComponent) },
      { path: 'logs/:id/structure', loadComponent: () => import('./pages/logs/log-structure-page.component').then((m) => m.LogStructurePageComponent) },
      { path: 'logs/:id', loadComponent: () => import('./pages/logs/logs-explorer.component').then((m) => m.LogsExplorerComponent) },
      { path: 'settings', loadComponent: () => import('./pages/settings/settings.component').then((m) => m.SettingsComponent) },
      // specs/031: My settings - this user's own (folders per PC, where sessions open, devices, sessions). `me` is no backend prefix.
      { path: 'me', loadComponent: () => import('./pages/me/me-page.component').then((m) => m.MePageComponent) },
    ],
  },
  // Stays outside the tab-nav layout - opened via window.open, wants the full page to itself.
  { path: 'view', loadComponent: () => import('./pages/json-view/json-view-page.component').then((m) => m.JsonViewPageComponent) },
  // The big-tab body/header editor (EditTabService) - outside the layout for the same reason.
  { path: 'edit', loadComponent: () => import('./pages/edit-view/edit-view-page.component').then((m) => m.EditViewPageComponent) },
  // A board chat in its own window (specs/022 FR-017) - outside the layout; `chat` is no backend prefix.
  { path: 'chat', loadComponent: () => import('./pages/chat-window/chat-window.component').then((m) => m.ChatWindowComponent) },
  // A board page popped out (specs/017 R30) - outside the layout too; the gateway and SpaPageFilter serve it the SPA.
  { path: 'board/page/:id', loadComponent: () => import('./pages/board-page-view/board-page-view.component').then((m) => m.BoardPageViewComponent) },
];
