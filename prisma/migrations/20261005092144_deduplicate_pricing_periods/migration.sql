CREATE OR REPLACE FUNCTION get_qualifying_price_periods() RETURNS TABLE (
  quarter_num INT,
  epoch BIGINT,
  log_index INT,
  lot_atto_usd NUMERIC,
  claim_atto_fil NUMERIC,
  claim_tx_hash TEXT
)
SET search_path = public AS $$
DECLARE
  q RECORD;
  v_last_lot_atto_usd NUMERIC := NULL;
  v_last_claim_atto_fil NUMERIC := NULL;

  -- Config
  v_activation_epoch BIGINT;
  v_epochs_per_quarter BIGINT;

  -- Quarter specific variables
  v_previous_quarter_price_periods_count INT := 0;
  v_quarter_results temp_auction_row[];
  v_row temp_auction_row;
BEGIN
  -- Read config
  SELECT activation_epoch, epochs_per_quarter
  INTO v_activation_epoch, v_epochs_per_quarter
  FROM application_config
  LIMIT 1;

  IF v_activation_epoch IS NULL OR v_epochs_per_quarter IS NULL THEN
    RETURN;
  END IF;

  FOR q IN
    SELECT DISTINCT FLOOR(
      (auctioned_at_epoch - v_activation_epoch)
      / v_epochs_per_quarter)
    AS q_index
    FROM filecoin_pay_fee_auction
    WHERE auctioned_at_epoch >= v_activation_epoch
    ORDER BY q_index
  LOOP
    -- Clear results on each iteration
    v_quarter_results := ARRAY[]::temp_auction_row[];

    SELECT ARRAY_AGG(
      ROW(
        res.quarter_num,
        res.epoch,
        res.log_index,
        res.lot_atto_usd,
        res.claim_atto_fil,
        res.claim_tx_hash
      )::temp_auction_row
      ORDER BY res.epoch, res.log_index
    ) INTO v_quarter_results
    FROM (
      WITH RECURSIVE
      parameters_by_quarter AS (
        SELECT
          parameter_type,
          parameter_value,
          update_epoch,
          update_log_index,
          CASE
            WHEN update_epoch < v_activation_epoch THEN 0
            ELSE FLOOR(
              (update_epoch - v_activation_epoch)::NUMERIC
              / v_epochs_per_quarter
            )::BIGINT + 1
          END AS quarter_num
        FROM service_rewards_actor_parameter
      ),
      parameters AS (
        SELECT DISTINCT ON(p.parameter_type, p.quarter_num)
          p.parameter_type,
          p.parameter_value,
          p.quarter_num
        FROM parameters_by_quarter p
        ORDER BY
          p.parameter_type,
          p.quarter_num,
          p.update_epoch DESC,
          p.update_log_index DESC
      ),

      contracts_by_quarter AS (
        SELECT
          c.contract_address,
          c.admittance_epoch,
          c.admittance_log_index,
          CASE
            WHEN c.admittance_epoch < v_activation_epoch THEN 0
            ELSE FLOOR(
              (c.admittance_epoch - v_activation_epoch)::NUMERIC 
              / v_epochs_per_quarter
            )::BIGINT + 1
          END AS admittance_quarter_num,
          CASE
            WHEN c.removal_epoch IS NULL THEN NULL
            WHEN c.removal_epoch < v_activation_epoch THEN 0
            ELSE FLOOR(
              (c.removal_epoch - v_activation_epoch)::NUMERIC
              / v_epochs_per_quarter
            )::BIGINT + 1
          END AS removal_quarter_num
        FROM filecoin_pay_contract c
      ),
      contracts AS (
        SELECT DISTINCT ON(c.contract_address, c.admittance_quarter_num) *
        FROM contracts_by_quarter c
        WHERE c.removal_quarter_num IS NULL
          OR c.removal_quarter_num > c.admittance_quarter_num
        ORDER BY 
          c.contract_address,
          c.admittance_quarter_num,
          c.admittance_epoch DESC,
          c.admittance_log_index DESC
      ),

      tokens_by_quarter AS (
        SELECT
          t.token_address,
          t.token_decimals,
          t.admittance_epoch,
          t.admittance_log_index,
          CASE
            WHEN t.admittance_epoch < v_activation_epoch THEN 0
            ELSE FLOOR(
              (t.admittance_epoch - v_activation_epoch)::NUMERIC
              / v_epochs_per_quarter
            )::BIGINT + 1
          END AS admittance_quarter_num,
          CASE
            WHEN t.removal_epoch IS NULL THEN NULL
            WHEN t.removal_epoch < v_activation_epoch THEN 0
            ELSE FLOOR(
              (t.removal_epoch - v_activation_epoch)::NUMERIC
              / v_epochs_per_quarter
            )::BIGINT + 1
          END AS removal_quarter_num
        FROM whitelisted_token t
      ),
      tokens AS (
        SELECT DISTINCT ON(t.token_address, t.admittance_quarter_num) *
        FROM tokens_by_quarter t
        WHERE t.removal_quarter_num IS NULL
          OR t.removal_quarter_num > t.admittance_quarter_num
        ORDER BY 
          t.token_address,
          t.admittance_quarter_num,
          t.admittance_epoch DESC,
          t.admittance_log_index DESC
      ),

      auctions_by_quarter AS (
        SELECT
          a.id,
          a.filecoin_pay_contract_address,
          a.tx_hash,
          a.amount_actual,
          a.fil_burned,
          a.token_address,
          a.auctioned_at_epoch,
          a.log_index,
          CASE
            WHEN a.auctioned_at_epoch < v_activation_epoch THEN 0
            ELSE FLOOR(
              (a.auctioned_at_epoch - v_activation_epoch)::NUMERIC / v_epochs_per_quarter
            )::BIGINT + 1
          END AS quarter_num
        FROM filecoin_pay_fee_auction a
      ),
      whitelisted_auctions AS (
        SELECT
          a.quarter_num,
          (a.amount_actual * POWER(10::NUMERIC, 18 - t.token_decimals))::NUMERIC
            AS lot_atto_usd,
          a.fil_burned AS claim_atto_fil,
          a.tx_hash AS claim_tx_hash,
          a.auctioned_at_epoch,
          a.log_index
        FROM auctions_by_quarter a
        INNER JOIN LATERAL (
          SELECT
            wt.token_address,
            wt.token_decimals
          FROM tokens wt
          WHERE a.token_address = wt.token_address
            AND a.quarter_num > wt.admittance_quarter_num
            AND (
              wt.removal_quarter_num IS NULL
              OR wt.removal_quarter_num >= a.quarter_num
            )
          ORDER BY wt.admittance_quarter_num DESC 
          LIMIT 1
        ) t ON TRUE
        WHERE EXISTS (
          SELECT
            c.contract_address
          FROM contracts c
          WHERE a.filecoin_pay_contract_address = c.contract_address
            AND c.admittance_quarter_num < a.quarter_num
            AND (
              c.removal_quarter_num IS NULL
              OR c.removal_quarter_num >= a.quarter_num
            )
        )
      ),
      substantial_auctions AS (
        SELECT
          a.quarter_num,
          a.lot_atto_usd,
          a.claim_atto_fil,
          a.claim_tx_hash,
          a.auctioned_at_epoch,
          a.log_index,
          ROW_NUMBER() OVER (ORDER BY a.auctioned_at_epoch, a.log_index) AS auction_num
        FROM whitelisted_auctions a
        INNER JOIN LATERAL (
          SELECT
            p.parameter_value
          FROM parameters p
          WHERE p.parameter_type = 'MIN_LOT_FLOOR'
            AND a.quarter_num > p.quarter_num
          ORDER BY p.quarter_num DESC
          LIMIT 1
        ) min_lot_floor ON TRUE
        INNER JOIN LATERAL (
          SELECT
            p.parameter_value
          FROM parameters p
          WHERE p.parameter_type = 'MIN_LOT_ALPHA_NUMERATOR'
            AND a.quarter_num > p.quarter_num
          ORDER BY p.quarter_num DESC
          LIMIT 1
        ) alpha_num ON TRUE
        INNER JOIN LATERAL (
          SELECT
            p.parameter_value
          FROM parameters p
          WHERE p.parameter_type = 'MIN_LOT_ALPHA_DENOMINATOR'
            AND a.quarter_num > p.quarter_num
          ORDER BY p.quarter_num DESC
          LIMIT 1
        ) alpha_den ON TRUE
        LEFT JOIN quarter_bound_volume v
          ON v.quarter_num = a.quarter_num - 1
        WHERE a.quarter_num > 0
          AND auction_passes_min_lot(
            a.lot_atto_usd,
            min_lot_floor.parameter_value,
            COALESCE(v.volume_atto_usd, 0),
            v_previous_quarter_price_periods_count,
            alpha_num.parameter_value,
            alpha_den.parameter_value
          ) = TRUE
      ),
      seed_auctions AS (
        SELECT
          a.lot_atto_usd,
          a.claim_atto_fil,
          a.auction_num AS id
        FROM substantial_auctions a
        WHERE a.auction_num <= 5
      ),
      seed_auctions_ranked AS (
        SELECT
          s1.lot_atto_usd,
          s1.claim_atto_fil,
          COUNT(s2.id) AS rank_pos
        FROM seed_auctions s1
        JOIN seed_auctions s2
          ON (s2.lot_atto_usd * s1.claim_atto_fil < s1.lot_atto_usd * s2.claim_atto_fil)
          OR (
            s2.lot_atto_usd * s1.claim_atto_fil = s1.lot_atto_usd * s2.claim_atto_fil
            AND s2.id <= s1.id
          )
        GROUP BY s1.id, s1.lot_atto_usd, s1.claim_atto_fil
      ),
      quarter_auctions AS (
        SELECT
          a.quarter_num,
          a.lot_atto_usd,
          a.claim_atto_fil,
          a.claim_tx_hash,
          a.auctioned_at_epoch,
          a.log_index,
          price_band_bps.parameter_value AS price_band_bps,
          ROW_NUMBER() OVER (ORDER BY a.auctioned_at_epoch, a.log_index) AS seq_id
        FROM substantial_auctions a
        INNER JOIN LATERAL (
          SELECT
            p.parameter_value
          FROM parameters p
          WHERE p.parameter_type = 'PRICE_BAND_BPS'
            AND a.quarter_num > p.quarter_num
          ORDER BY p.quarter_num DESC
          LIMIT 1
        ) price_band_bps ON TRUE
        WHERE a.auction_num > 5 -- first 5 auctions are to seed price band anchor
          AND a.quarter_num = q.q_index + 1
      ),
      flagged_auctions AS (
        SELECT
          fqa.seq_id,
          fqa.quarter_num,
          fqa.auctioned_at_epoch,
          fqa.log_index,
          fqa.lot_atto_usd,
          fqa.claim_atto_fil,
          fqa.claim_tx_hash,
          auction_passes_price_band(
            fqa.lot_atto_usd,
            fqa.claim_atto_fil,
            COALESCE(v_last_lot_atto_usd, median.lot_atto_usd),
            COALESCE(v_last_claim_atto_fil, median.claim_atto_fil),
            fqa.price_band_bps
          ) AS is_qualified,
          CASE
            WHEN auction_passes_price_band(
              fqa.lot_atto_usd,
              fqa.claim_atto_fil,
              COALESCE(v_last_lot_atto_usd, median.lot_atto_usd),
              COALESCE(v_last_claim_atto_fil, median.claim_atto_fil),
              fqa.price_band_bps
            ) THEN fqa.lot_atto_usd
            ELSE COALESCE(v_last_lot_atto_usd, median.lot_atto_usd)
          END AS last_lot_atto_usd,
          CASE
            WHEN auction_passes_price_band(
              fqa.lot_atto_usd,
              fqa.claim_atto_fil,
              COALESCE(v_last_lot_atto_usd, median.lot_atto_usd),
              COALESCE(v_last_claim_atto_fil, median.claim_atto_fil),
              fqa.price_band_bps
            ) THEN fqa.claim_atto_fil
            ELSE COALESCE(v_last_claim_atto_fil, median.claim_atto_fil)
          END AS last_claim_atto_fil
        FROM quarter_auctions fqa
        LEFT JOIN seed_auctions_ranked median
          ON median.rank_pos = 3
        WHERE fqa.seq_id = 1

        UNION ALL

        SELECT
          qa.seq_id,
          qa.quarter_num,
          qa.auctioned_at_epoch,
          qa.log_index,
          qa.lot_atto_usd,
          qa.claim_atto_fil,
          qa.claim_tx_hash,
          auction_passes_price_band(
            qa.lot_atto_usd,
            qa.claim_atto_fil,
            previous.last_lot_atto_usd,
            previous.last_claim_atto_fil,
            qa.price_band_bps
          ) AS is_qualified,
          CASE
            WHEN auction_passes_price_band(
              qa.lot_atto_usd,
              qa.claim_atto_fil,
              previous.last_lot_atto_usd,
              previous.last_claim_atto_fil,
              qa.price_band_bps
            ) THEN qa.lot_atto_usd
            ELSE previous.last_lot_atto_usd
          END AS last_lot_atto_usd,
          CASE
            WHEN auction_passes_price_band(
              qa.lot_atto_usd,
              qa.claim_atto_fil,
              previous.last_lot_atto_usd,
              previous.last_claim_atto_fil,
              qa.price_band_bps
            ) THEN qa.claim_atto_fil
            ELSE previous.last_claim_atto_fil
          END AS last_claim_atto_fil
        FROM quarter_auctions qa
        JOIN flagged_auctions previous ON qa.seq_id = previous.seq_id + 1
      )

      SELECT
        fa.quarter_num,
        fa.auctioned_at_epoch AS epoch,
        fa.log_index AS log_index,
        fa.lot_atto_usd,
        fa.claim_atto_fil,
        fa.claim_tx_hash
      FROM flagged_auctions fa
      WHERE fa.is_qualified = TRUE
    ) res;

    v_previous_quarter_price_periods_count := CASE
      WHEN v_quarter_results IS NOT NULL THEN CARDINALITY(v_quarter_results)
      ELSE 0
    END;

    IF v_quarter_results IS NOT NULL THEN
      FOREACH v_row IN ARRAY v_quarter_results
      LOOP
        quarter_num := v_row.quarter_num;
        epoch := v_row.epoch;
        log_index := v_row.log_index;
        lot_atto_usd := v_row.lot_atto_usd;
        claim_atto_fil := v_row.claim_atto_fil;
        claim_tx_hash := v_row.claim_tx_hash;
        RETURN NEXT;
      END LOOP;

      v_last_lot_atto_usd := v_quarter_results[ARRAY_UPPER(v_quarter_results, 1)].lot_atto_usd;
      v_last_claim_atto_fil := v_quarter_results[ARRAY_UPPER(v_quarter_results, 1)].claim_atto_fil;
    END IF;
  END LOOP;

  RETURN;
END;
$$ LANGUAGE plpgsql;

REFRESH MATERIALIZED VIEW qualified_price_periods_mv;
