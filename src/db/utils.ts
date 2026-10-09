import { SortKey, SortKeyBase, sortKeyBase } from '@/lib/schemas';
import { StrictMap } from '@/lib/utils';
import {
  Expression,
  expressionBuilder,
  SelectQueryBuilder,
  StringReference,
} from 'kysely';
import { DB } from './types';

export interface QuarterNumberParameters {
  epoch: Expression<string | bigint | number | null>;
  activationEpoch: Expression<string | bigint | number>;
  epochsPerQuarter: Expression<string | bigint | number>;
}

interface Sorting<T extends string> {
  key: T;
  order: 'asc' | 'desc';
}

function sortKeyToSorting<T extends string>(
  sortKey: SortKey<T>,
): Sorting<SortKeyBase<T>> {
  const descending = sortKey.startsWith('-');

  return {
    key: sortKeyBase(sortKey),
    order: descending ? 'desc' : 'asc',
  };
}

export function epochToQuarterNumber({
  epoch,
  activationEpoch,
  epochsPerQuarter,
}: QuarterNumberParameters) {
  const eb = expressionBuilder<DB>();

  return eb.fn<string | bigint | number>('FLOOR', [
    eb(
      eb(
        eb.cast(eb(epoch, '-', activationEpoch), 'numeric'),
        '/',
        eb.val(epochsPerQuarter),
      ),
      '+',
      eb.val(1),
    ),
  ]);
}

export function applyPagination<DB, TB extends keyof DB, O>(
  qb: SelectQueryBuilder<DB, TB, O>,
  {
    page = 1,
    limit,
  }: {
    page?: number;
    limit?: number;
  },
): SelectQueryBuilder<DB, TB, O> {
  if (limit === undefined) {
    return qb;
  }

  const offset = (page - 1) * limit;

  return qb.limit(limit).offset(offset);
}

export function applySorting<T extends string, DB, TB extends keyof DB, O>(
  qb: SelectQueryBuilder<DB, TB, O>,
  {
    sort,
    fieldMap,
  }: {
    sort?: SortKey<T>[];
    fieldMap:
      | Record<SortKeyBase<T>, StringReference<DB, TB>>
      | ((field: SortKeyBase<T>) => StringReference<DB, TB>);
  },
): SelectQueryBuilder<DB, TB, O> {
  const sortings = (sort ?? []).map(sortKeyToSorting);
  const fieldMapper = (() => {
    if (typeof fieldMap === 'function') return fieldMap;

    const map = new StrictMap(
      Object.entries(fieldMap) as [SortKeyBase<T>, StringReference<DB, TB>][],
    );
    return map.get.bind(map);
  })();

  return sortings.reduce((qb, sorting) => {
    return qb.orderBy(fieldMapper(sorting.key), sorting.order);
  }, qb);
}

export function selectQueryToCountQuery<DB, TB extends keyof DB, O>(
  qb: SelectQueryBuilder<DB, TB, O>,
) {
  return qb
    .clearSelect()
    .clearLimit()
    .clearOffset()
    .clearOrderBy()
    .clearGroupBy()
    .select((eb) => eb.fn.countAll().as('count'));
}
