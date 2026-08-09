import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Profile } from '../models/profile.model';
import { AppConfigService } from './app-config.service';

export interface NewProfileRequest {
  readonly name: string;
  readonly avatar?: string | null;
}

export interface ProfileUpdateRequest {
  readonly name?: string;
  readonly avatar?: string | null;
}

@Injectable({ providedIn: 'root' })
export class ProfilesApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  private get baseUrl(): string {
    return `${this.config.backendUrl}/profiles`;
  }

  list(): Observable<Profile[]> {
    return this.http.get<Profile[]>(this.baseUrl);
  }

  create(request: NewProfileRequest): Observable<Profile> {
    return this.http.post<Profile>(this.baseUrl, request);
  }

  update(id: string, request: ProfileUpdateRequest): Observable<Profile> {
    return this.http.patch<Profile>(`${this.baseUrl}/${id}`, request);
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${id}`);
  }
}
