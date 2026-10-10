import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { LowDiskBannerComponent } from './low-disk-banner.component';
import { StorageApiService } from '../../core/services/storage-api.service';

describe('LowDiskBannerComponent', () => {
  function render(lowDisk: boolean): HTMLElement {
    TestBed.configureTestingModule({
      imports: [LowDiskBannerComponent],
      providers: [provideRouter([]), { provide: StorageApiService, useValue: { disk: () => of({ freeBytes: 3 * 1024 ** 3, totalBytes: 100, lowDisk, warnGb: 10 }) } }],
    });
    const fixture = TestBed.createComponent(LowDiskBannerComponent);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('warns on every tab while the disk is under the limit', () => {
    expect(render(true).textContent).toContain('The disk is almost full');
  });

  it('says nothing while there is room', () => {
    expect(render(false).textContent?.trim()).toBe('');
  });
});
