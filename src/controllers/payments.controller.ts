import {
  paginatedPaymentsListSchema,
  paymentsQuerySchema,
  type PaymentsQuery,
} from '@/lib/schemas';
import { PaymentsService } from '@/services/payments.service';
import { Controller, Get, Query, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';

@Controller('/payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get('/')
  @SerializeOptions({ schema: paginatedPaymentsListSchema })
  @ApiOkResponse({
    description: 'Paginated payments list.',
    standardSchema: paginatedPaymentsListSchema,
  })
  public getPayments(
    @Query({ schema: paymentsQuerySchema }) query: PaymentsQuery,
  ) {
    return this.paymentsService.getPaymentsPaginated(query);
  }
}
