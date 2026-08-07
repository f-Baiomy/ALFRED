import { Component, input } from '@angular/core';
import { CallRecord } from '../../core/models/call.model';
import { callKey } from '../../shared/utils/call-utils';
import { CallCardComponent } from '../call-card/call-card.component';

@Component({
  selector: 'app-supplier-group',
  standalone: true,
  imports: [CallCardComponent],
  templateUrl: './supplier-group.component.html',
})
export class SupplierGroupComponent {
  readonly supplier = input.required<string>();
  readonly calls = input.required<readonly CallRecord[]>();

  readonly trackByCallKey = callKey;
}
