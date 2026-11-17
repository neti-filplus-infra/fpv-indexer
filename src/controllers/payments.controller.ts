import {
  type PaginatedPaymentsList,
  paginatedPaymentsList,
  paymentsQuery,
  type PaymentsQuery,
} from '@/lib/schemas';
import { PaymentsService } from '@/services/payments.service';
import { Controller, Get, Query, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';

@Controller('/payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get('/')
  @SerializeOptions({ schema: paginatedPaymentsList })
  @ApiOkResponse({
    description: 'Paginated payments list.',
    standardSchema: paginatedPaymentsList,
  })
  public getPayments(
    @Query({ schema: paymentsQuery }) query: PaymentsQuery,
  ): Promise<PaginatedPaymentsList> {
    return this.paymentsService.getPaymentsPaginated(query);
  }
}
