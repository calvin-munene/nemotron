import { randomUUID } from 'node:crypto';
import { normalizeAssistantMode } from './assistantModes.js';
import { initializePlatformFoundation } from './platformRuntime.js';

const MAX_INT64 = 9_223_372_036_854_775_807n;
const MAX_STAR_AMOUNT = 10_000;
const DEFAULT_RESERVATION_TTL_MS = 10 * 60 * 1000;

const SCHEMA_SQL = '/* star-ledger:schema */ SELECT 1';

export class StarLedgerValidationError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'StarLedgerValidationError';
  }
}

export class StarLedgerConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StarLedgerConflictError';
  }
}

export function normalizeTelegramUserId(value) {
  let normalized;

  if (typeof value === 'bigint') {
    normalized = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new StarLedgerValidationError('userId must be a safe integer, bigint, or decimal string');
    }
    normalized = BigInt(value);
  } else if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    normalized = BigInt(value);
  } else {
    throw new StarLedgerValidationError('userId must be a positive integer');
  }

  if (normalized <= 0n || normalized > MAX_INT64) {
    throw new StarLedgerValidationError('userId is outside the PostgreSQL BIGINT range');
  }

  return normalized.toString();
}

export function normalizeStarAmount(value, fieldName = 'amount') {
  let normalized;

  if (typeof value === 'bigint') {
    if (value < 1n || value > BigInt(MAX_STAR_AMOUNT)) {
      throw new StarLedgerValidationError(`${fieldName} must be between 1 and ${MAX_STAR_AMOUNT}`);
    }
    normalized = Number(value);
  } else if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = BigInt(value);
    if (parsed < 1n || parsed > BigInt(MAX_STAR_AMOUNT)) {
      throw new StarLedgerValidationError(`${fieldName} must be between 1 and ${MAX_STAR_AMOUNT}`);
    }
    normalized = Number(parsed);
  } else if (typeof value === 'number' && Number.isInteger(value)) {
    normalized = value;
  } else {
    throw new StarLedgerValidationError(`${fieldName} must be an integer between 1 and ${MAX_STAR_AMOUNT}`);
  }

  if (normalized < 1 || normalized > MAX_STAR_AMOUNT) {
    throw new StarLedgerValidationError(`${fieldName} must be between 1 and ${MAX_STAR_AMOUNT}`);
  }

  return normalized;
}

function normalizeNonEmptyString(value, fieldName, maxLength = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new StarLedgerValidationError(`${fieldName} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function normalizeOptionalString(value, fieldName, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  return normalizeNonEmptyString(value, fieldName, maxLength);
}

function normalizeBoolean(value, fieldName) {
  if (typeof value !== 'boolean') throw new StarLedgerValidationError(`${fieldName} must be a boolean`);
  return value;
}

function normalizeDbInt(value, fieldName = 'database integer') {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value).toString();
  throw new Error(`Invalid ${fieldName} returned by PostgreSQL`);
}

function normalizeDateFromClock(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('now() returned an invalid date');
  return date;
}

function userControlRow(userId, row = {}) {
  return {
    userId: normalizeDbInt(row.user_id ?? userId, 'user_id'),
    banned: row.banned === true,
    banReason: row.ban_reason ?? null,
    unlimitedCredits: row.unlimited_credits === true,
    persona: row.persona ?? null,
    selectedMode: normalizeAssistantMode(row.selected_mode || 'chat', { fallback: 'chat' }),
    preferredModel: row.preferred_model ?? null,
    preferredLanguage: row.preferred_language || 'auto',
    responseLength: row.response_length || 'balanced',
    creativity: Number(row.creativity ?? 0.4),
    memoryEnabled: row.memory_enabled !== false,
    customInstructions: row.custom_instructions ?? null,
  };
}

function assertPositiveInteger(value, fieldName, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new StarLedgerValidationError(`${fieldName} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function normalizeHistoryLimit(value, fallback = 50) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 250) {
    throw new StarLedgerValidationError('limit must be an integer between 1 and 250');
  }
  return parsed;
}

export function createStarLedger({
  pool: injectedPool,
  connectionString = process.env.DATABASE_URL,
  reservationTtlMs = DEFAULT_RESERVATION_TTL_MS,
  now = () => new Date(),
} = {}) {
  assertPositiveInteger(reservationTtlMs, 'reservationTtlMs');
  if (typeof now !== 'function') throw new StarLedgerValidationError('now must be a function');

  let pool = injectedPool ?? null;
  let ownsPool = false;
  let poolPromise = null;
  let schemaPromise = null;
  let closed = false;

  async function resolvePool() {
    if (closed) throw new Error('Star ledger is closed');
    if (pool) return pool;
    if (poolPromise) return poolPromise;
    if (!connectionString) {
      throw new Error('DATABASE_URL is required for the Telegram Stars ledger');
    }

    poolPromise = import('pg')
      .then(({ Pool }) => {
        pool = new Pool({ connectionString });
        ownsPool = true;
        return pool;
      })
      .catch((error) => {
        poolPromise = null;
        throw error;
      });
    return poolPromise;
  }

  async function init() {
    if (schemaPromise) return schemaPromise;
    schemaPromise = (connectionString && !injectedPool ? initializePlatformFoundation() : Promise.resolve())
      .then(() => resolvePool())
      .then((resolvedPool) => resolvedPool.query(SCHEMA_SQL))
      .then(() => undefined)
      .catch((error) => {
        schemaPromise = null;
        throw error;
      });
    return schemaPromise;
  }

  async function transaction(work) {
    await init();
    const resolvedPool = await resolvePool();
    const client = await resolvedPool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function ensureAccount(client, userId) {
    await client.query(
      `/* star-ledger:ensure-account */
       INSERT INTO telegram_star_accounts (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
  }

  async function lockPaymentCharge(client, telegramPaymentChargeId) {
    await client.query(
      `/* star-ledger:lock-payment-charge */
       SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [telegramPaymentChargeId],
    );
  }

  async function creditPayment({
    userId: rawUserId,
    amount: rawAmount,
    telegramPaymentChargeId: rawChargeId,
    providerPaymentChargeId,
    invoicePayload,
    currency = 'XTR',
  } = {}) {
    const userId = normalizeTelegramUserId(rawUserId);
    const amount = normalizeStarAmount(rawAmount);
    const telegramPaymentChargeId = normalizeNonEmptyString(
      rawChargeId,
      'telegramPaymentChargeId',
      256,
    );
    const normalizedProviderChargeId = normalizeOptionalString(
      providerPaymentChargeId,
      'providerPaymentChargeId',
      256,
    );
    const normalizedInvoicePayload = normalizeOptionalString(invoicePayload, 'invoicePayload', 128);
    if (currency !== 'XTR') {
      throw new StarLedgerValidationError('currency must be XTR');
    }

    return transaction(async (client) => {
      await lockPaymentCharge(client, telegramPaymentChargeId);
      await ensureAccount(client, userId);
      const inserted = await client.query(
        `/* star-ledger:insert-payment */
         INSERT INTO telegram_star_payments (
           telegram_payment_charge_id,
           provider_payment_charge_id,
           user_id,
           amount,
           currency,
           invoice_payload
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (telegram_payment_charge_id) DO NOTHING
         RETURNING telegram_payment_charge_id`,
        [
          telegramPaymentChargeId,
          normalizedProviderChargeId,
          userId,
          amount,
          currency,
          normalizedInvoicePayload,
        ],
      );

      let credited = inserted.rowCount === 1;
      let refunded = false;
      if (credited) {
        await client.query(
          `/* star-ledger:credit-account */
           UPDATE telegram_star_accounts
           SET balance = balance + $2, updated_at = NOW()
           WHERE user_id = $1`,
          [userId, amount],
        );
      } else {
        const existing = await client.query(
          `/* star-ledger:get-payment */
           SELECT user_id::text, amount, currency, refunded_at
           FROM telegram_star_payments
           WHERE telegram_payment_charge_id = $1`,
          [telegramPaymentChargeId],
        );
        const payment = existing.rows[0];
        if (
          !payment ||
          normalizeDbInt(payment.user_id, 'payment user_id') !== userId ||
          Number(payment.amount) !== amount ||
          payment.currency !== currency
        ) {
          throw new StarLedgerConflictError(
            'telegramPaymentChargeId is already associated with a different payment',
          );
        }
        credited = false;
        refunded = Boolean(payment.refunded_at);
      }

      const balanceResult = await client.query(
        `/* star-ledger:get-balance-client */
         SELECT balance::text FROM telegram_star_accounts WHERE user_id = $1`,
        [userId],
      );

      return {
        credited,
        refunded,
        userId,
        amount,
        telegramPaymentChargeId,
        balance: normalizeDbInt(balanceResult.rows[0]?.balance ?? '0', 'balance'),
      };
    });
  }

  async function recordRefund({
    telegramPaymentChargeId: rawChargeId,
    userId: rawUserId,
    amount: rawAmount,
  } = {}) {
    const telegramPaymentChargeId = normalizeNonEmptyString(
      rawChargeId,
      'telegramPaymentChargeId',
      256,
    );
    const expectedUserId = rawUserId === undefined || rawUserId === null
      ? null
      : normalizeTelegramUserId(rawUserId);
    const expectedAmount = rawAmount === undefined || rawAmount === null
      ? null
      : normalizeStarAmount(rawAmount);

    return transaction(async (client) => {
      await lockPaymentCharge(client, telegramPaymentChargeId);
      const paymentResult = await client.query(
        `/* star-ledger:get-payment-for-refund */
         SELECT
           telegram_payment_charge_id,
           user_id::text,
           amount,
           currency,
           invoice_payload,
           credited_at,
           refunded_at,
           refunded_amount
         FROM telegram_star_payments
         WHERE telegram_payment_charge_id = $1
         FOR UPDATE`,
        [telegramPaymentChargeId],
      );
      const row = paymentResult.rows[0];
      if (!row) {
        if (expectedUserId === null || expectedAmount === null) {
          throw new StarLedgerConflictError(
            'an unknown refund requires the original payment userId and amount',
          );
        }
        await ensureAccount(client, expectedUserId);
        const inserted = await client.query(
          `/* star-ledger:insert-refunded-payment */
           INSERT INTO telegram_star_payments (
             telegram_payment_charge_id,
             user_id,
             amount,
             currency,
             refunded_at,
             refunded_amount
           ) VALUES ($1, $2, $3, 'XTR', NOW(), $3)
           RETURNING credited_at, refunded_at, refunded_amount`,
          [telegramPaymentChargeId, expectedUserId, expectedAmount],
        );
        const balanceResult = await client.query(
          `/* star-ledger:get-balance-client */
           SELECT balance::text FROM telegram_star_accounts WHERE user_id = $1`,
          [expectedUserId],
        );
        return {
          changed: true,
          pendingPayment: true,
          balance: normalizeDbInt(balanceResult.rows[0]?.balance ?? '0', 'balance'),
          deductedAmount: '0',
          payment: {
            telegramPaymentChargeId,
            userId: expectedUserId,
            amount: expectedAmount,
            currency: 'XTR',
            invoicePayload: null,
            creditedAt: inserted.rows[0].credited_at,
            refundedAt: inserted.rows[0].refunded_at,
            refundedAmount: Number(inserted.rows[0].refunded_amount),
          },
        };
      }

      const userId = normalizeDbInt(row.user_id, 'payment user_id');
      const amount = normalizeStarAmount(row.amount);
      if (expectedUserId !== null && expectedUserId !== userId) {
        throw new StarLedgerConflictError('refund userId does not match the credited payment');
      }
      if (expectedAmount !== null && expectedAmount !== amount) {
        throw new StarLedgerConflictError('refund amount does not match the credited payment');
      }

      const accountResult = await client.query(
        `/* star-ledger:get-account-for-refund */
         SELECT balance::text
         FROM telegram_star_accounts
         WHERE user_id = $1
         FOR UPDATE`,
        [userId],
      );
      const currentBalance = BigInt(
        normalizeDbInt(accountResult.rows[0]?.balance ?? '0', 'balance'),
      );
      const payment = {
        telegramPaymentChargeId,
        userId,
        amount,
        currency: row.currency,
        invoicePayload: row.invoice_payload ?? null,
        creditedAt: row.credited_at,
        refundedAt: row.refunded_at ?? null,
        refundedAmount: row.refunded_amount === null || row.refunded_amount === undefined
          ? null
          : Number(row.refunded_amount),
      };

      if (row.refunded_at) {
        return {
          changed: false,
          balance: currentBalance.toString(),
          deductedAmount: '0',
          payment,
        };
      }

      const deductedAmount = currentBalance < BigInt(amount) ? currentBalance : BigInt(amount);
      const updatedBalance = currentBalance - deductedAmount;
      await client.query(
        `/* star-ledger:deduct-refund */
         UPDATE telegram_star_accounts
         SET balance = $2::bigint, updated_at = NOW()
         WHERE user_id = $1`,
        [userId, updatedBalance.toString()],
      );
      const marked = await client.query(
        `/* star-ledger:mark-payment-refunded */
         UPDATE telegram_star_payments
         SET refunded_at = NOW(), refunded_amount = $2
         WHERE telegram_payment_charge_id = $1
         RETURNING refunded_at, refunded_amount`,
        [telegramPaymentChargeId, amount],
      );

      return {
        changed: true,
        balance: updatedBalance.toString(),
        deductedAmount: deductedAmount.toString(),
        payment: {
          ...payment,
          refundedAt: marked.rows[0].refunded_at,
          refundedAmount: Number(marked.rows[0].refunded_amount),
        },
      };
    });
  }

  async function getBalance(rawUserId) {
    const userId = normalizeTelegramUserId(rawUserId);
    await init();
    const resolvedPool = await resolvePool();
    const result = await resolvedPool.query(
      `/* star-ledger:get-balance */
       SELECT balance::text FROM telegram_star_accounts WHERE user_id = $1`,
      [userId],
    );
    return {
      userId,
      balance: normalizeDbInt(result.rows[0]?.balance ?? '0', 'balance'),
    };
  }

  async function acceptTerms(rawUserId, rawVersion = 'v1') {
    const userId = normalizeTelegramUserId(rawUserId);
    const version = normalizeNonEmptyString(rawVersion, 'terms version', 64);
    return transaction(async (client) => {
      await ensureAccount(client, userId);
      const result = await client.query(
        `/* star-ledger:accept-terms */
         INSERT INTO telegram_star_terms_acceptances (user_id, terms_version)
         VALUES ($1, $2)
         ON CONFLICT (user_id, terms_version)
         DO UPDATE SET accepted_at = telegram_star_terms_acceptances.accepted_at
         RETURNING accepted_at`,
        [userId, version],
      );
      return {
        userId,
        version,
        acceptedAt: result.rows[0].accepted_at,
      };
    });
  }

  async function hasAcceptedTerms(rawUserId, rawVersion = 'v1') {
    const userId = normalizeTelegramUserId(rawUserId);
    const version = normalizeNonEmptyString(rawVersion, 'terms version', 64);
    await init();
    const resolvedPool = await resolvePool();
    const result = await resolvedPool.query(
      `/* star-ledger:has-accepted-terms */
       SELECT 1
       FROM telegram_star_terms_acceptances
       WHERE user_id = $1 AND terms_version = $2`,
      [userId, version],
    );
    return result.rowCount > 0;
  }

  async function reservePrompt(rawUserId, { cost: rawCost = 1, reservationId: rawId } = {}) {
    const userId = normalizeTelegramUserId(rawUserId);
    const cost = normalizeStarAmount(rawCost, 'cost');
    const reservationId = rawId === undefined
      ? randomUUID()
      : normalizeNonEmptyString(rawId, 'reservationId', 128);

    return transaction(async (client) => {
      await ensureAccount(client, userId);
      const inserted = await client.query(
        `/* star-ledger:insert-reservation */
         INSERT INTO telegram_star_prompt_reservations (reservation_id, user_id, cost)
         VALUES ($1, $2, $3)
         ON CONFLICT (reservation_id) DO NOTHING
         RETURNING reservation_id`,
        [reservationId, userId, cost],
      );

      if (inserted.rowCount === 0) {
        const existingResult = await client.query(
          `/* star-ledger:get-reservation-client */
           SELECT user_id::text, cost, status
           FROM telegram_star_prompt_reservations
           WHERE reservation_id = $1
           FOR UPDATE`,
          [reservationId],
        );
        const existing = existingResult.rows[0];
        if (
          !existing ||
          normalizeDbInt(existing.user_id, 'reservation user_id') !== userId ||
          Number(existing.cost) !== cost
        ) {
          throw new StarLedgerConflictError(
            'reservationId is already associated with a different reservation',
          );
        }
        const balanceResult = await client.query(
          `/* star-ledger:get-balance-client */
           SELECT balance::text FROM telegram_star_accounts WHERE user_id = $1`,
          [userId],
        );
        return {
          reserved: false,
          changed: false,
          reservationId,
          userId,
          cost,
          state: existing.status,
          balance: normalizeDbInt(balanceResult.rows[0]?.balance ?? '0', 'balance'),
        };
      }

      const debit = await client.query(
        `/* star-ledger:debit-account */
         UPDATE telegram_star_accounts
         SET balance = balance - $2, updated_at = NOW()
         WHERE user_id = $1 AND balance >= $2
         RETURNING balance::text`,
        [userId, cost],
      );
      if (debit.rowCount === 0) {
        await client.query(
          `/* star-ledger:delete-reservation */
           DELETE FROM telegram_star_prompt_reservations WHERE reservation_id = $1`,
          [reservationId],
        );
        const balanceResult = await client.query(
          `/* star-ledger:get-balance-client */
           SELECT balance::text FROM telegram_star_accounts WHERE user_id = $1`,
          [userId],
        );
        return {
          reserved: false,
          changed: false,
          reservationId: null,
          userId,
          cost,
          state: null,
          balance: normalizeDbInt(balanceResult.rows[0]?.balance ?? '0', 'balance'),
        };
      }

      return {
        reserved: true,
        changed: true,
        reservationId,
        userId,
        cost,
        state: 'reserved',
        balance: normalizeDbInt(debit.rows[0].balance, 'balance'),
      };
    });
  }

  async function completePrompt(rawReservationId) {
    const reservationId = normalizeNonEmptyString(rawReservationId, 'reservationId', 128);
    await init();
    const resolvedPool = await resolvePool();
    const updated = await resolvedPool.query(
      `/* star-ledger:complete-reservation */
       UPDATE telegram_star_prompt_reservations
       SET status = 'completed', completed_at = NOW(), updated_at = NOW()
       WHERE reservation_id = $1 AND status IN (
         'reserved', 'generation_started', 'response_produced', 'delivery_attempted', 'delivered', 'completion_pending'
       )
       RETURNING user_id::text, cost, status`,
      [reservationId],
    );
    if (updated.rowCount === 1) {
      const row = updated.rows[0];
      return {
        completed: true,
        changed: true,
        reservationId,
        userId: normalizeDbInt(row.user_id, 'reservation user_id'),
        cost: Number(row.cost),
        state: row.status,
      };
    }

    const existing = await resolvedPool.query(
      `/* star-ledger:get-reservation */
       SELECT user_id::text, cost, status
       FROM telegram_star_prompt_reservations
       WHERE reservation_id = $1`,
      [reservationId],
    );
    const row = existing.rows[0];
    return {
      completed: row?.status === 'completed',
      changed: false,
      reservationId,
      userId: row ? normalizeDbInt(row.user_id, 'reservation user_id') : null,
      cost: row ? Number(row.cost) : null,
      state: row?.status ?? null,
    };
  }

  async function transitionPrompt(rawReservationId, nextState, { errorCode = null } = {}) {
    const reservationId = normalizeNonEmptyString(rawReservationId, 'reservationId', 128);
    const transitions = {
      generation_started: { from: ['reserved'], column: 'generation_started_at' },
      response_produced: { from: ['generation_started', 'reserved'], column: 'response_produced_at' },
      delivery_attempted: { from: ['response_produced'], column: 'delivery_attempted_at' },
      delivered: { from: ['delivery_attempted', 'response_produced'], column: 'delivered_at' },
      completion_pending: { from: ['response_produced', 'delivery_attempted', 'delivered'], column: 'completion_pending_at' },
      failed: { from: ['reserved', 'generation_started'], column: 'failed_at' },
    };
    const transition = transitions[nextState];
    if (!transition) throw new StarLedgerValidationError('prompt transition is invalid');
    const normalizedError = normalizeOptionalString(errorCode, 'errorCode', 128);
    await init();
    const resolvedPool = await resolvePool();
    const result = await resolvedPool.query(
      `/* star-ledger:transition-reservation */
       UPDATE telegram_star_prompt_reservations
       SET status = $2, ${transition.column} = NOW(), last_error_code = $3, updated_at = NOW()
       WHERE reservation_id = $1 AND status = ANY($4::text[])
       RETURNING user_id::text, cost, status`,
      [reservationId, nextState, normalizedError, transition.from],
    );
    if (result.rowCount) return { changed: true, reservationId, state: result.rows[0].status };
    const existing = await resolvedPool.query(
      `/* star-ledger:get-reservation */
       SELECT user_id::text, cost, status FROM telegram_star_prompt_reservations WHERE reservation_id = $1`,
      [reservationId],
    );
    return { changed: false, reservationId, state: existing.rows[0]?.status ?? null };
  }

  async function recoverPendingCompletions({ limit = 100 } = {}) {
    assertPositiveInteger(limit, 'limit', 1_000);
    return transaction(async (client) => {
      const result = await client.query(
        `/* star-ledger:recover-completions */
         WITH pending AS (
           SELECT reservation_id FROM telegram_star_prompt_reservations
           WHERE status IN ('response_produced', 'delivery_attempted', 'delivered', 'completion_pending')
           ORDER BY updated_at, reservation_id LIMIT $1 FOR UPDATE SKIP LOCKED
         )
         UPDATE telegram_star_prompt_reservations AS reservations
         SET status = 'completed', completed_at = NOW(), updated_at = NOW(), last_error_code = NULL
         FROM pending WHERE reservations.reservation_id = pending.reservation_id
         RETURNING reservations.reservation_id`,
        [limit],
      );
      return { completedCount: result.rowCount, reservationIds: result.rows.map((row) => row.reservation_id) };
    });
  }

  async function restorePrompt(rawReservationId) {
    const reservationId = normalizeNonEmptyString(rawReservationId, 'reservationId', 128);
    return transaction(async (client) => {
      const existingResult = await client.query(
        `/* star-ledger:get-reservation-client */
         SELECT user_id::text, cost, status
         FROM telegram_star_prompt_reservations
         WHERE reservation_id = $1
         FOR UPDATE`,
        [reservationId],
      );
      const row = existingResult.rows[0];
      if (!row) {
        return {
          restored: false,
          changed: false,
          reservationId,
          userId: null,
          cost: null,
          state: null,
          balance: null,
        };
      }

      const userId = normalizeDbInt(row.user_id, 'reservation user_id');
      const cost = Number(row.cost);
      if (!['reserved', 'generation_started', 'failed'].includes(row.status)) {
        const balanceResult = await client.query(
          `/* star-ledger:get-balance-client */
           SELECT balance::text FROM telegram_star_accounts WHERE user_id = $1`,
          [userId],
        );
        return {
          restored: row.status === 'restored',
          changed: false,
          reservationId,
          userId,
          cost,
          state: row.status,
          balance: normalizeDbInt(balanceResult.rows[0]?.balance ?? '0', 'balance'),
        };
      }

      await client.query(
        `/* star-ledger:restore-reservation */
         UPDATE telegram_star_prompt_reservations
         SET status = 'restored', restored_at = NOW(), updated_at = NOW()
         WHERE reservation_id = $1 AND status IN ('reserved', 'generation_started', 'failed')`,
        [reservationId],
      );
      const balanceResult = await client.query(
        `/* star-ledger:refund-account */
         UPDATE telegram_star_accounts
         SET balance = balance + $2, updated_at = NOW()
         WHERE user_id = $1
         RETURNING balance::text`,
        [userId, cost],
      );
      return {
        restored: true,
        changed: true,
        reservationId,
        userId,
        cost,
        state: 'restored',
        balance: normalizeDbInt(balanceResult.rows[0].balance, 'balance'),
      };
    });
  }

  async function refundStaleReservations({ olderThanMs = reservationTtlMs, limit = 100 } = {}) {
    assertPositiveInteger(olderThanMs, 'olderThanMs');
    assertPositiveInteger(limit, 'limit', 1_000);
    const cutoff = new Date(normalizeDateFromClock(now).getTime() - olderThanMs);

    return transaction(async (client) => {
      const restored = await client.query(
        `/* star-ledger:restore-stale */
         WITH stale AS (
           SELECT reservation_id
           FROM telegram_star_prompt_reservations
           WHERE status IN ('reserved', 'generation_started', 'failed') AND created_at < $1
           ORDER BY created_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         UPDATE telegram_star_prompt_reservations AS reservations
         SET status = 'restored', restored_at = NOW(), updated_at = NOW()
         FROM stale
         WHERE reservations.reservation_id = stale.reservation_id
           AND reservations.status IN ('reserved', 'generation_started', 'failed')
         RETURNING reservations.user_id::text, reservations.cost`,
        [cutoff, limit],
      );

      const refunds = new Map();
      let refundedAmount = 0n;
      for (const row of restored.rows) {
        const userId = normalizeDbInt(row.user_id, 'reservation user_id');
        const cost = BigInt(normalizeStarAmount(row.cost, 'reservation cost'));
        refunds.set(userId, (refunds.get(userId) ?? 0n) + cost);
        refundedAmount += cost;
      }

      for (const [userId, amount] of refunds) {
        await client.query(
          `/* star-ledger:refund-stale-account */
           UPDATE telegram_star_accounts
           SET balance = balance + $2::bigint, updated_at = NOW()
           WHERE user_id = $1`,
          [userId, amount.toString()],
        );
      }

      return {
        restoredCount: restored.rowCount,
        refundedAmount: refundedAmount.toString(),
      };
    });
  }

  async function getStats() {
    await init();
    const resolvedPool = await resolvePool();
    const result = await resolvedPool.query(`
      /* star-ledger:get-stats */
      SELECT
        (SELECT COUNT(*)::text FROM telegram_star_accounts) AS total_users,
        (SELECT COALESCE(SUM(balance), 0)::text FROM telegram_star_accounts) AS total_balance,
        (SELECT COUNT(*)::text FROM telegram_star_payments) AS payment_count,
        (SELECT COALESCE(SUM(amount), 0)::text FROM telegram_star_payments) AS total_stars_purchased,
        (SELECT COUNT(*)::text FROM telegram_star_terms_acceptances) AS terms_acceptance_count,
        (SELECT COUNT(*)::text FROM telegram_star_prompt_reservations WHERE status = 'reserved') AS reserved_prompts,
        (SELECT COUNT(*)::text FROM telegram_star_prompt_reservations WHERE status = 'completed') AS completed_prompts,
        (SELECT COUNT(*)::text FROM telegram_star_prompt_reservations WHERE status = 'restored') AS restored_prompts,
        (SELECT COALESCE(SUM(cost), 0)::text FROM telegram_star_prompt_reservations WHERE status = 'completed') AS total_stars_spent
    `);
    const row = result.rows[0];
    return {
      totalUsers: normalizeDbInt(row.total_users, 'total_users'),
      totalBalance: normalizeDbInt(row.total_balance, 'total_balance'),
      paymentCount: normalizeDbInt(row.payment_count, 'payment_count'),
      totalStarsPurchased: normalizeDbInt(row.total_stars_purchased, 'total_stars_purchased'),
      termsAcceptanceCount: normalizeDbInt(row.terms_acceptance_count, 'terms_acceptance_count'),
      reservedPrompts: normalizeDbInt(row.reserved_prompts, 'reserved_prompts'),
      completedPrompts: normalizeDbInt(row.completed_prompts, 'completed_prompts'),
      restoredPrompts: normalizeDbInt(row.restored_prompts, 'restored_prompts'),
      totalStarsSpent: normalizeDbInt(row.total_stars_spent, 'total_stars_spent'),
    };
  }

  async function listPayments({ userId: rawUserId = null, limit: rawLimit = 50 } = {}) {
    const userId = rawUserId === null || rawUserId === undefined ? null : normalizeTelegramUserId(rawUserId);
    const limit = normalizeHistoryLimit(rawLimit);
    await init();
    const resolvedPool = await resolvePool();
    const result = await resolvedPool.query(
      `/* star-ledger:list-payments */
       SELECT telegram_payment_charge_id, user_id::text, amount, currency,
              provider_payment_charge_id, credited_at, refunded_at, refunded_amount
       FROM telegram_star_payments
       WHERE ($1::bigint IS NULL OR user_id = $1::bigint)
       ORDER BY credited_at DESC, telegram_payment_charge_id DESC
       LIMIT $2`,
      [userId, limit],
    );
    return result.rows.map((row) => ({
      chargeId: row.telegram_payment_charge_id,
      userId: normalizeDbInt(row.user_id, 'payment user_id'),
      amount: Number(row.amount),
      currency: row.currency,
      providerChargeId: row.provider_payment_charge_id || null,
      creditedAt: row.credited_at,
      refundedAt: row.refunded_at || null,
      refundedAmount: row.refunded_amount === null || row.refunded_amount === undefined ? null : Number(row.refunded_amount),
    }));
  }

  async function listUsage({ userId: rawUserId = null, limit: rawLimit = 50 } = {}) {
    const userId = rawUserId === null || rawUserId === undefined ? null : normalizeTelegramUserId(rawUserId);
    const limit = normalizeHistoryLimit(rawLimit);
    await init();
    const resolvedPool = await resolvePool();
    const result = await resolvedPool.query(
      `/* star-ledger:list-usage */
       SELECT reservation_id, user_id::text, cost, status, created_at, completed_at, restored_at,
              generation_started_at, response_produced_at, delivery_attempted_at, delivered_at,
              completion_pending_at, failed_at, updated_at
       FROM telegram_star_prompt_reservations
       WHERE ($1::bigint IS NULL OR user_id = $1::bigint)
       ORDER BY created_at DESC, reservation_id DESC
       LIMIT $2`,
      [userId, limit],
    );
    return result.rows.map((row) => ({
      reservationId: row.reservation_id,
      userId: normalizeDbInt(row.user_id, 'usage user_id'),
      cost: Number(row.cost),
      status: row.status,
      createdAt: row.created_at,
      completedAt: row.completed_at || null,
      restoredAt: row.restored_at || null,
      generationStartedAt: row.generation_started_at || null,
      responseProducedAt: row.response_produced_at || null,
      deliveryAttemptedAt: row.delivery_attempted_at || null,
      deliveredAt: row.delivered_at || null,
      completionPendingAt: row.completion_pending_at || null,
      failedAt: row.failed_at || null,
      updatedAt: row.updated_at,
    }));
  }

  async function reserveProviderCapacity({
    providerKey: rawProviderKey = 'nvidia',
    limit: rawLimit,
    cost: rawCost = 1,
    windowSeconds: rawWindowSeconds = 3600,
  } = {}) {
    const providerKey = normalizeNonEmptyString(rawProviderKey, 'providerKey', 64);
    const limit = assertPositiveInteger(rawLimit, 'limit', 1_000_000);
    const cost = assertPositiveInteger(rawCost, 'cost', 100);
    const windowSeconds = assertPositiveInteger(rawWindowSeconds, 'windowSeconds', 86_400);
    if (cost > limit) {
      return { reserved: false, providerKey, used: null, limit, resetAt: null };
    }

    const date = normalizeDateFromClock(now);
    const windowMs = windowSeconds * 1000;
    const bucketStart = new Date(Math.floor(date.getTime() / windowMs) * windowMs);
    const resetAt = new Date(bucketStart.getTime() + windowMs);
    await init();
    const resolvedPool = await resolvePool();
    const reserved = await resolvedPool.query(
      `/* star-ledger:reserve-provider-capacity */
       INSERT INTO ai_provider_usage_buckets (provider_key, bucket_start, used, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (provider_key, bucket_start)
       DO UPDATE SET used = ai_provider_usage_buckets.used + EXCLUDED.used, updated_at = NOW()
       WHERE ai_provider_usage_buckets.used + EXCLUDED.used <= $4
       RETURNING used`,
      [providerKey, bucketStart, cost, limit],
    );
    return {
      reserved: reserved.rowCount === 1,
      providerKey,
      used: reserved.rowCount === 1 ? Number(reserved.rows[0].used) : null,
      limit,
      resetAt,
    };
  }

  async function getModeSettings(defaultModes = {}) {
    if (typeof defaultModes !== 'object' || defaultModes === null) {
      throw new StarLedgerValidationError('defaultModes must be an object');
    }
    await init();
    const resolvedPool = await resolvePool();
    const result = await resolvedPool.query(
      `/* star-ledger:get-mode-settings */
       SELECT mode, enabled FROM telegram_bot_modes`,
    );
    const modes = { ...defaultModes };
    for (const row of result.rows) {
      if (Object.hasOwn(defaultModes, row.mode)) modes[row.mode] = row.enabled === true;
    }
    return modes;
  }

  async function setModeEnabled(rawMode, rawEnabled) {
    const mode = normalizeNonEmptyString(rawMode, 'mode', 64);
    const enabled = normalizeBoolean(rawEnabled, 'enabled');
    await init();
    const resolvedPool = await resolvePool();
    const result = await resolvedPool.query(
      `/* star-ledger:set-mode-enabled */
       INSERT INTO telegram_bot_modes (mode, enabled, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (mode)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()
       RETURNING mode, enabled, updated_at`,
      [mode, enabled],
    );
    return {
      mode: result.rows[0].mode,
      enabled: result.rows[0].enabled === true,
      updatedAt: result.rows[0].updated_at,
    };
  }

  async function getUserControl(rawUserId) {
    const userId = normalizeTelegramUserId(rawUserId);
    await init();
    const resolvedPool = await resolvePool();
    const result = await resolvedPool.query(
      `/* star-ledger:get-user-control */
       SELECT user_id::text, banned, ban_reason, unlimited_credits, persona, selected_mode,
              preferred_model, preferred_language, response_length, creativity,
              memory_enabled, custom_instructions
       FROM telegram_user_controls
       WHERE user_id = $1`,
      [userId],
    );
    const row = result.rows[0] || {};
    return userControlRow(userId, row);
  }

  async function setUserBan(rawUserId, rawBanned, rawReason = null) {
    const userId = normalizeTelegramUserId(rawUserId);
    const banned = normalizeBoolean(rawBanned, 'banned');
    const reason = normalizeOptionalString(rawReason, 'banReason', 500);
    return transaction(async (client) => {
      await ensureAccount(client, userId);
      const result = await client.query(
        `/* star-ledger:set-user-ban */
         INSERT INTO telegram_user_controls (user_id, banned, ban_reason, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id)
         DO UPDATE SET banned = EXCLUDED.banned, ban_reason = EXCLUDED.ban_reason, updated_at = NOW()
         RETURNING user_id::text, banned, ban_reason, unlimited_credits, persona, selected_mode,
                   preferred_model, preferred_language, response_length, creativity, memory_enabled, custom_instructions`,
        [userId, banned, reason],
      );
      const row = result.rows[0];
      return userControlRow(userId, row);
    });
  }

  async function setUserPersona(rawUserId, rawPersona) {
    const userId = normalizeTelegramUserId(rawUserId);
    const persona = normalizeOptionalString(rawPersona, 'persona', 1000);
    return transaction(async (client) => {
      await ensureAccount(client, userId);
      const result = await client.query(
        `/* star-ledger:set-user-persona */
         INSERT INTO telegram_user_controls (user_id, persona, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id)
         DO UPDATE SET persona = EXCLUDED.persona, updated_at = NOW()
         RETURNING user_id::text, banned, ban_reason, unlimited_credits, persona, selected_mode,
                   preferred_model, preferred_language, response_length, creativity, memory_enabled, custom_instructions`,
        [userId, persona],
      );
      const row = result.rows[0];
      return userControlRow(userId, row);
    });
  }

  async function setUserMode(rawUserId, rawMode) {
    const userId = normalizeTelegramUserId(rawUserId);
    const selectedMode = normalizeAssistantMode(rawMode);
    return transaction(async (client) => {
      await ensureAccount(client, userId);
      const result = await client.query(
        `/* star-ledger:set-user-mode */
         INSERT INTO telegram_user_controls (user_id, selected_mode, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id)
         DO UPDATE SET selected_mode = EXCLUDED.selected_mode, updated_at = NOW()
         RETURNING user_id::text, banned, ban_reason, unlimited_credits, persona, selected_mode,
                   preferred_model, preferred_language, response_length, creativity, memory_enabled, custom_instructions`,
        [userId, selectedMode],
      );
      const row = result.rows[0];
      return userControlRow(userId, row);
    });
  }

  async function setUserModel(rawUserId, rawModel) {
    const userId = normalizeTelegramUserId(rawUserId);
    const preferredModel = normalizeOptionalString(rawModel, 'preferredModel', 200);
    return transaction(async (client) => {
      await ensureAccount(client, userId);
      const result = await client.query(
        `/* star-ledger:set-user-model */
         INSERT INTO telegram_user_controls (user_id, preferred_model, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id)
         DO UPDATE SET preferred_model = EXCLUDED.preferred_model, updated_at = NOW()
         RETURNING user_id::text, banned, ban_reason, unlimited_credits, persona, selected_mode,
                   preferred_model, preferred_language, response_length, creativity, memory_enabled, custom_instructions`,
        [userId, preferredModel],
      );
      return userControlRow(userId, result.rows[0]);
    });
  }

  async function setUserAiSettings(rawUserId, settings = {}) {
    const userId = normalizeTelegramUserId(rawUserId);
    const preferredModel = normalizeOptionalString(settings.preferredModel, 'preferredModel', 200);
    const language = normalizeOptionalString(settings.preferredLanguage ?? 'auto', 'preferredLanguage', 32) || 'auto';
    const responseLength = String(settings.responseLength ?? 'balanced');
    if (!['concise', 'balanced', 'detailed'].includes(responseLength)) throw new StarLedgerValidationError('responseLength is invalid');
    const creativity = Number(settings.creativity ?? 0.4);
    if (!Number.isFinite(creativity) || creativity < 0 || creativity > 2) throw new StarLedgerValidationError('creativity must be between 0 and 2');
    const memoryEnabled = settings.memoryEnabled === undefined ? true : normalizeBoolean(settings.memoryEnabled, 'memoryEnabled');
    const customInstructions = normalizeOptionalString(settings.customInstructions, 'customInstructions', 2000);
    return transaction(async (client) => {
      await ensureAccount(client, userId);
      const result = await client.query(
        `/* star-ledger:set-user-ai-settings */
         INSERT INTO telegram_user_controls (
           user_id, preferred_model, preferred_language, response_length, creativity, memory_enabled, custom_instructions, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           preferred_model = COALESCE(EXCLUDED.preferred_model, telegram_user_controls.preferred_model),
           preferred_language = EXCLUDED.preferred_language,
           response_length = EXCLUDED.response_length,
           creativity = EXCLUDED.creativity,
           memory_enabled = EXCLUDED.memory_enabled,
           custom_instructions = EXCLUDED.custom_instructions,
           updated_at = NOW()
         RETURNING user_id::text, banned, ban_reason, unlimited_credits, persona, selected_mode,
                   preferred_model, preferred_language, response_length, creativity, memory_enabled, custom_instructions`,
        [userId, preferredModel, language, responseLength, creativity, memoryEnabled, customInstructions],
      );
      return userControlRow(userId, result.rows[0]);
    });
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (poolPromise) {
      try {
        await poolPromise;
      } catch {
        return;
      }
    }
    if (ownsPool && pool?.end) await pool.end();
  }

  return {
    init,
    creditPayment,
    recordRefund,
    getBalance,
    acceptTerms,
    hasAcceptedTerms,
    reservePrompt,
    completePrompt,
    transitionPrompt,
    recoverPendingCompletions,
    restorePrompt,
    refundStaleReservations,
    reserveProviderCapacity,
    getStats,
    listPayments,
    listUsage,
    getModeSettings,
    setModeEnabled,
    getUserControl,
    setUserBan,
    setUserPersona,
    setUserMode,
    setUserModel,
    setUserAiSettings,
    close,
  };
}
