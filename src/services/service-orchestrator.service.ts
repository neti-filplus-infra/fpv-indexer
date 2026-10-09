import { db } from '@/db/db';
import { ServiceOrchestrator, ServiceOrchestratorsList } from '@/lib/schemas';
import { numericToBigInt } from '@/lib/utils';
import { Injectable } from '@nestjs/common';
import { groupBy } from 'es-toolkit';

@Injectable()
export class ServiceOrchestratorService {
  public async getServiceOrchestrators(): Promise<ServiceOrchestratorsList> {
    const results = await db
      .selectFrom('service_orchestrator_admission')
      .selectAll()
      .execute();

    const groupedResults = groupBy(results, (i) => i.service_orchestrator_id);

    return Object.entries(groupedResults).map(([id, admissions]) => {
      return {
        id,
        admissionPeriods: admissions.map((admission) => {
          return {
            wallet: admission.wallet,
            admissionEpoch: numericToBigInt(admission.admission_epoch),
            admissionLogIndex: admission.admission_log_index,
            admissionTxHash: admission.admission_tx_hash,
            removalEpoch: admission.removal_epoch
              ? numericToBigInt(admission.removal_epoch)
              : null,
            removalLogIndex: admission.removal_log_index,
            removalTxHash: admission.removal_tx_hash,
          };
        }),
      } satisfies ServiceOrchestrator;
    });
  }
}
