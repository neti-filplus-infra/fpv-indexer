CREATE OR REPLACE FUNCTION auction_passes_min_lot(
  lot_atto_usd NUMERIC,
  min_lot_floor NUMERIC,
  bound_volume NUMERIC,
  n INT, 
  alpha_numerator NUMERIC, 
  alpha_denominator NUMERIC
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $func$
  SELECT lot_atto_usd >= min_lot_floor
    AND (
      bound_volume = 0
      OR n = 0
      OR lot_atto_usd * alpha_denominator * n
        >= alpha_numerator * bound_volume - (alpha_denominator * n - 1)
    )
$func$;

REFRESH MATERIALIZED VIEW qualified_price_periods_mv;