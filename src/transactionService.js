const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const { pool, executeWithRetry } = require("./db");
const logger = require("./logger");

/**
 * Transaction Service
 * Implements double-entry ledger with ACID guarantees
 * Handles concurrency, race conditions, and deadlock prevention
 */
class TransactionService {
  /**
   * Process a wallet top-up transaction
   * User purchases credits with real money
   *
   * @param {string} userId - User identifier
   * @param {string} assetCode - Asset type code (e.g., 'GOLD_COIN')
   * @param {number} amount - Amount to add
   * @param {string} idempotencyKey - Unique key to prevent duplicate processing
   * @param {object} metadata - Additional transaction metadata
   * @returns {Promise<object>} Transaction result
   */
  async topUp(userId, assetCode, amount, idempotencyKey, metadata = {}) {
    logger.info("Processing top-up transaction", {
      userId,
      assetCode,
      amount,
      idempotencyKey,
    });

    // Validate inputs
    if (!userId || !assetCode || !amount || !idempotencyKey) {
      throw new Error("Missing required parameters");
    }

    if (amount <= 0) {
      throw new Error("Amount must be positive");
    }

    // Check idempotency first (outside transaction for performance)
    const existingResult = await this._checkIdempotency(idempotencyKey);
    if (existingResult) {
      logger.info("Returning cached result for idempotent request", {
        idempotencyKey,
      });
      return existingResult;
    }

    // Execute transaction with retry logic for deadlock handling
    return await executeWithRetry(async () => {
      return await this._executeTopUpTransaction(
        userId,
        assetCode,
        amount,
        idempotencyKey,
        metadata,
      );
    });
  }

  /**
   * Internal method to execute top-up transaction
   * Runs within a database transaction with proper locking
   */
  async _executeTopUpTransaction(
    userId,
    assetCode,
    amount,
    idempotencyKey,
    metadata,
  ) {
    const client = await pool.connect();

    try {
      // Start transaction with serializable isolation level
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");

      // Get asset type
      const assetResult = await client.query(
        "SELECT id FROM asset_types WHERE code = $1 AND is_active = true",
        [assetCode],
      );

      if (assetResult.rows.length === 0) {
        throw new Error(`Asset type ${assetCode} not found or inactive`);
      }

      const assetTypeId = assetResult.rows[0].id;

      // Get user account with lock
      const userAccountResult = await client.query(
        `SELECT id FROM accounts 
                 WHERE user_id = $1 AND is_active = true
                 FOR UPDATE NOWAIT`,
        [userId],
      );

      if (userAccountResult.rows.length === 0) {
        throw new Error(`User account ${userId} not found or inactive`);
      }

      const userAccountId = userAccountResult.rows[0].id;

      // Get system treasury account
      const treasuryResult = await client.query(
        `SELECT a.id FROM accounts a
                 JOIN account_types at ON a.account_type_id = at.id
                 WHERE at.code = 'SYSTEM_TREASURY' AND a.is_active = true`,
      );

      if (treasuryResult.rows.length === 0) {
        throw new Error("System treasury account not found");
      }

      const treasuryAccountId = treasuryResult.rows[0].id;

      // Lock accounts in deterministic order to prevent deadlocks
      // Always lock in sorted order by account ID
      const accountIds = [userAccountId, treasuryAccountId].sort();

      // Lock both accounts (one is already locked, lock the other)
      if (accountIds[0] !== userAccountId) {
        await client.query(
          "SELECT id FROM accounts WHERE id = $1 FOR UPDATE NOWAIT",
          [accountIds[0]],
        );
      }
      if (accountIds[1] !== userAccountId) {
        await client.query(
          "SELECT id FROM accounts WHERE id = $1 FOR UPDATE NOWAIT",
          [accountIds[1]],
        );
      }

      // Get transaction type
      const txnTypeResult = await client.query(
        "SELECT id FROM transaction_types WHERE code = $1",
        ["TOP_UP"],
      );
      const transactionTypeId = txnTypeResult.rows[0].id;

      // Create transaction record
      const transactionId = uuidv4();
      const description =
        metadata.description || `Top-up ${amount} ${assetCode}`;

      await client.query(
        `INSERT INTO transactions 
   (id, idempotency_key, transaction_type_id, asset_type_id, amount, description, metadata, status, completed_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          transactionId,
          idempotencyKey,
          transactionTypeId,
          assetTypeId,
          amount,
          description,
          JSON.stringify(metadata),
          "completed",
          new Date(),
        ],
      );

      // Get current balances
      const treasuryBalance = await this._getBalance(
        client,
        treasuryAccountId,
        assetTypeId,
      );
      const userBalance = await this._getBalance(
        client,
        userAccountId,
        assetTypeId,
      );

      // Verify treasury has sufficient balance
      if (treasuryBalance < amount) {
        throw new Error("Insufficient treasury balance");
      }

      // Calculate new balances
      const newTreasuryBalance =
        parseFloat(treasuryBalance) - parseFloat(amount);
      const newUserBalance = parseFloat(userBalance) + parseFloat(amount);

      // Create double-entry ledger entries
      // Debit from treasury
      await client.query(
        `INSERT INTO ledger_entries 
                 (transaction_id, account_id, asset_type_id, entry_type, amount, running_balance, description)
                 VALUES ($1, $2, $3, 'debit', $4, $5, $6)`,
        [
          transactionId,
          treasuryAccountId,
          assetTypeId,
          amount,
          newTreasuryBalance,
          "Debit from treasury for user top-up",
        ],
      );

      // Credit to user
      await client.query(
        `INSERT INTO ledger_entries 
                 (transaction_id, account_id, asset_type_id, entry_type, amount, running_balance, description)
                 VALUES ($1, $2, $3, 'credit', $4, $5, $6)`,
        [
          transactionId,
          userAccountId,
          assetTypeId,
          amount,
          newUserBalance,
          "Credit to user wallet",
        ],
      );

      // Update balance cache atomically
      await this._updateBalanceCache(
        client,
        treasuryAccountId,
        assetTypeId,
        newTreasuryBalance,
        transactionId,
      );
      await this._updateBalanceCache(
        client,
        userAccountId,
        assetTypeId,
        newUserBalance,
        transactionId,
      );

      // Create idempotency log
      const responseData = {
        transactionId,
        userId,
        assetCode,
        amount,
        newBalance: newUserBalance,
        timestamp: new Date().toISOString(),
      };

      await client.query(
        `INSERT INTO idempotency_log 
   (idempotency_key, request_hash, response_data, status, expires_at)
   VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + INTERVAL '24 hours')`,
        [
          idempotencyKey,
          this._hashRequest({ userId, assetCode, amount }),
          JSON.stringify(responseData),
          "completed",
        ],
      );

      // Create audit log
      await this._createAuditLog(
        client,
        transactionId,
        userAccountId,
        "TOP_UP",
        {
          userId,
          assetCode,
          amount,
          idempotencyKey,
        },
      );

      // Commit transaction
      await client.query("COMMIT");

      logger.info("Top-up transaction completed successfully", {
        transactionId,
        userId,
        amount,
        newBalance: newUserBalance,
      });

      return responseData;
    } catch (error) {
      await client.query("ROLLBACK");
      logger.error("Top-up transaction failed", {
        error: error.message,
        userId,
        assetCode,
        amount,
        idempotencyKey,
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Issue bonus/incentive credits to a user
   *
   * @param {string} userId - User identifier
   * @param {string} assetCode - Asset type code
   * @param {number} amount - Amount to award
   * @param {string} idempotencyKey - Unique key
   * @param {object} metadata - Additional metadata (reason, campaign, etc.)
   * @returns {Promise<object>} Transaction result
   */
  async issueBonus(userId, assetCode, amount, idempotencyKey, metadata = {}) {
    logger.info("Processing bonus transaction", {
      userId,
      assetCode,
      amount,
      idempotencyKey,
    });

    // Validate inputs
    if (!userId || !assetCode || !amount || !idempotencyKey) {
      throw new Error("Missing required parameters");
    }

    if (amount <= 0) {
      throw new Error("Amount must be positive");
    }

    // Check idempotency
    const existingResult = await this._checkIdempotency(idempotencyKey);
    if (existingResult) {
      logger.info("Returning cached result for idempotent request", {
        idempotencyKey,
      });
      return existingResult;
    }

    // Execute with retry
    return await executeWithRetry(async () => {
      return await this._executeIssueBonusTransaction(
        userId,
        assetCode,
        amount,
        idempotencyKey,
        metadata,
      );
    });
  }

  /**
   * Internal method to execute bonus transaction
   */
  async _executeIssueBonusTransaction(
    userId,
    assetCode,
    amount,
    idempotencyKey,
    metadata,
  ) {
    const client = await pool.connect();

    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");

      // Get asset type
      const assetResult = await client.query(
        "SELECT id FROM asset_types WHERE code = $1 AND is_active = true",
        [assetCode],
      );

      if (assetResult.rows.length === 0) {
        throw new Error(`Asset type ${assetCode} not found`);
      }

      const assetTypeId = assetResult.rows[0].id;

      // Get user account
      const userAccountResult = await client.query(
        `SELECT id FROM accounts 
                 WHERE user_id = $1 AND is_active = true`,
        [userId],
      );

      if (userAccountResult.rows.length === 0) {
        throw new Error(`User account ${userId} not found`);
      }

      const userAccountId = userAccountResult.rows[0].id;

      // Get bonus pool account
      const bonusPoolResult = await client.query(
        `SELECT a.id FROM accounts a
                 JOIN account_types at ON a.account_type_id = at.id
                 WHERE at.code = 'SYSTEM_BONUS' AND a.is_active = true`,
      );

      if (bonusPoolResult.rows.length === 0) {
        throw new Error("Bonus pool account not found");
      }

      const bonusPoolAccountId = bonusPoolResult.rows[0].id;

      // Lock accounts in order
      const accountIds = [userAccountId, bonusPoolAccountId].sort();
      await client.query(
        "SELECT id FROM accounts WHERE id = ANY($1) ORDER BY id FOR UPDATE NOWAIT",
        [accountIds],
      );

      // Get transaction type
      const txnTypeResult = await client.query(
        "SELECT id FROM transaction_types WHERE code = $1",
        ["BONUS"],
      );
      const transactionTypeId = txnTypeResult.rows[0].id;

      // Create transaction
      const transactionId = uuidv4();
      const description = metadata.reason || `Bonus ${amount} ${assetCode}`;

      await client.query(
        `INSERT INTO transactions 
   (id, idempotency_key, transaction_type_id, asset_type_id, amount, description, metadata, status, completed_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          transactionId,
          idempotencyKey,
          transactionTypeId,
          assetTypeId,
          amount,
          description,
          JSON.stringify(metadata),
          "completed",
          new Date(),
        ],
      );

      // Get balances
      const bonusPoolBalance = await this._getBalance(
        client,
        bonusPoolAccountId,
        assetTypeId,
      );
      const userBalance = await this._getBalance(
        client,
        userAccountId,
        assetTypeId,
      );

      // Check bonus pool has sufficient balance
      if (bonusPoolBalance < amount) {
        throw new Error("Insufficient bonus pool balance");
      }

      // Calculate new balances
      const newBonusPoolBalance =
        parseFloat(bonusPoolBalance) - parseFloat(amount);
      const newUserBalance = parseFloat(userBalance) + parseFloat(amount);

      // Double-entry: Debit from bonus pool
      await client.query(
        `INSERT INTO ledger_entries 
                 (transaction_id, account_id, asset_type_id, entry_type, amount, running_balance, description)
                 VALUES ($1, $2, $3, 'debit', $4, $5, $6)`,
        [
          transactionId,
          bonusPoolAccountId,
          assetTypeId,
          amount,
          newBonusPoolBalance,
          "Debit from bonus pool",
        ],
      );

      // Credit to user
      await client.query(
        `INSERT INTO ledger_entries 
                 (transaction_id, account_id, asset_type_id, entry_type, amount, running_balance, description)
                 VALUES ($1, $2, $3, 'credit', $4, $5, $6)`,
        [
          transactionId,
          userAccountId,
          assetTypeId,
          amount,
          newUserBalance,
          "Bonus credit to user",
        ],
      );

      // Update balance cache
      await this._updateBalanceCache(
        client,
        bonusPoolAccountId,
        assetTypeId,
        newBonusPoolBalance,
        transactionId,
      );
      await this._updateBalanceCache(
        client,
        userAccountId,
        assetTypeId,
        newUserBalance,
        transactionId,
      );

      // Idempotency log
      const responseData = {
        transactionId,
        userId,
        assetCode,
        amount,
        newBalance: newUserBalance,
        reason: metadata.reason,
        timestamp: new Date().toISOString(),
      };

      await client.query(
        `INSERT INTO idempotency_log 
   (idempotency_key, request_hash, response_data, status, expires_at)
   VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + INTERVAL '24 hours')`,
        [
          idempotencyKey,
          this._hashRequest({ userId, assetCode, amount }),
          JSON.stringify(responseData),
          "completed",
        ],
      );

      // Audit log
      await this._createAuditLog(
        client,
        transactionId,
        userAccountId,
        "BONUS",
        {
          userId,
          assetCode,
          amount,
          reason: metadata.reason,
        },
      );

      await client.query("COMMIT");

      logger.info("Bonus transaction completed successfully", {
        transactionId,
        userId,
        amount,
        newBalance: newUserBalance,
      });

      return responseData;
    } catch (error) {
      await client.query("ROLLBACK");
      logger.error("Bonus transaction failed", {
        error: error.message,
        userId,
        assetCode,
        amount,
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Process a purchase/spend transaction
   * User spends credits on in-app items or services
   *
   * @param {string} userId - User identifier
   * @param {string} assetCode - Asset type code
   * @param {number} amount - Amount to spend
   * @param {string} idempotencyKey - Unique key
   * @param {object} metadata - Purchase details (itemId, itemName, etc.)
   * @returns {Promise<object>} Transaction result
   */
  async purchase(userId, assetCode, amount, idempotencyKey, metadata = {}) {
    logger.info("Processing purchase transaction", {
      userId,
      assetCode,
      amount,
      idempotencyKey,
    });

    // Validate inputs
    if (!userId || !assetCode || !amount || !idempotencyKey) {
      throw new Error("Missing required parameters");
    }

    if (amount <= 0) {
      throw new Error("Amount must be positive");
    }

    // Check idempotency
    const existingResult = await this._checkIdempotency(idempotencyKey);
    if (existingResult) {
      logger.info("Returning cached result for idempotent request", {
        idempotencyKey,
      });
      return existingResult;
    }

    // Execute with retry
    return await executeWithRetry(async () => {
      return await this._executePurchaseTransaction(
        userId,
        assetCode,
        amount,
        idempotencyKey,
        metadata,
      );
    });
  }

  /**
   * Internal method to execute purchase transaction
   */
  async _executePurchaseTransaction(
    userId,
    assetCode,
    amount,
    idempotencyKey,
    metadata,
  ) {
    const client = await pool.connect();

    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");

      // Get asset type
      const assetResult = await client.query(
        "SELECT id FROM asset_types WHERE code = $1 AND is_active = true",
        [assetCode],
      );

      if (assetResult.rows.length === 0) {
        throw new Error(`Asset type ${assetCode} not found`);
      }

      const assetTypeId = assetResult.rows[0].id;

      // Get user account
      const userAccountResult = await client.query(
        `SELECT id FROM accounts 
                 WHERE user_id = $1 AND is_active = true`,
        [userId],
      );

      if (userAccountResult.rows.length === 0) {
        throw new Error(`User account ${userId} not found`);
      }

      const userAccountId = userAccountResult.rows[0].id;

      // Get revenue account
      const revenueResult = await client.query(
        `SELECT a.id FROM accounts a
                 JOIN account_types at ON a.account_type_id = at.id
                 WHERE at.code = 'SYSTEM_REVENUE' AND a.is_active = true`,
      );

      if (revenueResult.rows.length === 0) {
        throw new Error("Revenue account not found");
      }

      const revenueAccountId = revenueResult.rows[0].id;

      // Lock accounts in order
      const accountIds = [userAccountId, revenueAccountId].sort();
      await client.query(
        "SELECT id FROM accounts WHERE id = ANY($1) ORDER BY id FOR UPDATE NOWAIT",
        [accountIds],
      );

      // Get transaction type
      const txnTypeResult = await client.query(
        "SELECT id FROM transaction_types WHERE code = $1",
        ["PURCHASE"],
      );
      const transactionTypeId = txnTypeResult.rows[0].id;

      // Get user balance
      const userBalance = await this._getBalance(
        client,
        userAccountId,
        assetTypeId,
      );

      // Check sufficient balance
      if (userBalance < amount) {
        throw new Error(
          `Insufficient balance. Available: ${userBalance}, Required: ${amount}`,
        );
      }

      // Create transaction
      const transactionId = uuidv4();
      const description = metadata.itemName
        ? `Purchase ${metadata.itemName} for ${amount} ${assetCode}`
        : `Purchase for ${amount} ${assetCode}`;

      await client.query(
        `INSERT INTO transactions 
   (id, idempotency_key, transaction_type_id, asset_type_id, amount, description, metadata, status, completed_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          transactionId,
          idempotencyKey,
          transactionTypeId,
          assetTypeId,
          amount,
          description,
          JSON.stringify(metadata),
          "completed",
          new Date(),
        ],
      );

      // Get revenue balance
      const revenueBalance = await this._getBalance(
        client,
        revenueAccountId,
        assetTypeId,
      );

      // Calculate new balances
      const newUserBalance = parseFloat(userBalance) - parseFloat(amount);
      const newRevenueBalance = parseFloat(revenueBalance) + parseFloat(amount);

      // Double-entry: Debit from user
      await client.query(
        `INSERT INTO ledger_entries 
                 (transaction_id, account_id, asset_type_id, entry_type, amount, running_balance, description)
                 VALUES ($1, $2, $3, 'debit', $4, $5, $6)`,
        [
          transactionId,
          userAccountId,
          assetTypeId,
          amount,
          newUserBalance,
          "Debit from user for purchase",
        ],
      );

      // Credit to revenue
      await client.query(
        `INSERT INTO ledger_entries 
                 (transaction_id, account_id, asset_type_id, entry_type, amount, running_balance, description)
                 VALUES ($1, $2, $3, 'credit', $4, $5, $6)`,
        [
          transactionId,
          revenueAccountId,
          assetTypeId,
          amount,
          newRevenueBalance,
          "Revenue from user purchase",
        ],
      );

      // Update balance cache
      await this._updateBalanceCache(
        client,
        userAccountId,
        assetTypeId,
        newUserBalance,
        transactionId,
      );
      await this._updateBalanceCache(
        client,
        revenueAccountId,
        assetTypeId,
        newRevenueBalance,
        transactionId,
      );

      // Idempotency log
      const responseData = {
        transactionId,
        userId,
        assetCode,
        amount,
        newBalance: newUserBalance,
        item: metadata.itemName || metadata.itemId,
        timestamp: new Date().toISOString(),
      };

      await client.query(
        `INSERT INTO idempotency_log 
   (idempotency_key, request_hash, response_data, status, expires_at)
   VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + INTERVAL '24 hours')`,
        [
          idempotencyKey,
          this._hashRequest({ userId, assetCode, amount }),
          JSON.stringify(responseData),
          "completed",
        ],
      );

      // Audit log
      await this._createAuditLog(
        client,
        transactionId,
        userAccountId,
        "PURCHASE",
        {
          userId,
          assetCode,
          amount,
          item: metadata.itemName || metadata.itemId,
        },
      );

      await client.query("COMMIT");

      logger.info("Purchase transaction completed successfully", {
        transactionId,
        userId,
        amount,
        newBalance: newUserBalance,
      });

      return responseData;
    } catch (error) {
      await client.query("ROLLBACK");
      logger.error("Purchase transaction failed", {
        error: error.message,
        userId,
        assetCode,
        amount,
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get account balance for a specific asset
   */
  async getBalance(userId, assetCode) {
    const client = await pool.connect();

    try {
      const result = await client.query(
        `SELECT bc.balance, at.name as asset_name, at.code as asset_code
                 FROM balance_cache bc
                 JOIN accounts a ON bc.account_id = a.id
                 JOIN asset_types at ON bc.asset_type_id = at.id
                 WHERE a.user_id = $1 AND at.code = $2`,
        [userId, assetCode],
      );

      if (result.rows.length === 0) {
        return {
          userId,
          assetCode,
          balance: 0,
          assetName: null,
        };
      }

      return {
        userId,
        assetCode: result.rows[0].asset_code,
        assetName: result.rows[0].asset_name,
        balance: parseFloat(result.rows[0].balance),
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get all balances for a user
   */
  async getAllBalances(userId) {
    const client = await pool.connect();

    try {
      const result = await client.query(
        `SELECT at.code as asset_code, at.name as asset_name, bc.balance
                 FROM accounts a
                 LEFT JOIN balance_cache bc ON a.id = bc.account_id
                 LEFT JOIN asset_types at ON bc.asset_type_id = at.id
                 WHERE a.user_id = $1 AND at.is_active = true
                 ORDER BY at.code`,
        [userId],
      );

      const balances = result.rows.map((row) => ({
        assetCode: row.asset_code,
        assetName: row.asset_name,
        balance: parseFloat(row.balance || 0),
      }));

      // If user has no balances, return all asset types with 0 balance
      if (balances.length === 0 || balances.every((b) => !b.assetCode)) {
        const assetsResult = await client.query(
          "SELECT code as asset_code, name as asset_name FROM asset_types WHERE is_active = true ORDER BY code",
        );
        return {
          userId,
          balances: assetsResult.rows.map((row) => ({
            assetCode: row.asset_code,
            assetName: row.asset_name,
            balance: 0,
          })),
        };
      }

      return {
        userId,
        balances: balances.filter((b) => b.assetCode),
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get transaction history for a user
   */
  async getTransactionHistory(userId, limit = 50, offset = 0) {
    const client = await pool.connect();

    try {
      const result = await client.query(
        `SELECT 
                    t.id,
                    t.idempotency_key,
                    tt.name as transaction_type,
                    tt.code as transaction_code,
                    at.name as asset_name,
                    at.code as asset_code,
                    t.amount,
                    t.description,
                    t.metadata,
                    t.status,
                    t.created_at,
                    le.entry_type,
                    le.running_balance
                 FROM transactions t
                 JOIN ledger_entries le ON t.id = le.transaction_id
                 JOIN accounts a ON le.account_id = a.id
                 JOIN transaction_types tt ON t.transaction_type_id = tt.id
                 JOIN asset_types at ON t.asset_type_id = at.id
                 WHERE a.user_id = $1
                 ORDER BY t.created_at DESC
                 LIMIT $2 OFFSET $3`,
        [userId, limit, offset],
      );

      return {
        userId,
        transactions: result.rows.map((row) => ({
          id: row.id,
          type: row.transaction_type,
          typeCode: row.transaction_code,
          asset: row.asset_name,
          assetCode: row.asset_code,
          amount: parseFloat(row.amount),
          entryType: row.entry_type,
          runningBalance: parseFloat(row.running_balance),
          description: row.description,
          metadata: row.metadata,
          status: row.status,
          timestamp: row.created_at,
        })),
        limit,
        offset,
      };
    } finally {
      client.release();
    }
  }

  // ========================================================================
  // HELPER METHODS
  // ========================================================================

  /**
   * Check if request has already been processed (idempotency)
   */
  async _checkIdempotency(idempotencyKey) {
    const client = await pool.connect();

    try {
      const result = await client.query(
        `SELECT response_data, status 
                 FROM idempotency_log 
                 WHERE idempotency_key = $1 AND expires_at > CURRENT_TIMESTAMP`,
        [idempotencyKey],
      );

      if (result.rows.length > 0 && result.rows[0].status === "completed") {
        return result.rows[0].response_data;
      }

      return null;
    } finally {
      client.release();
    }
  }

  /**
   * Get current balance from cache
   */
  async _getBalance(client, accountId, assetTypeId) {
    const result = await client.query(
      "SELECT balance FROM balance_cache WHERE account_id = $1 AND asset_type_id = $2",
      [accountId, assetTypeId],
    );

    return result.rows.length > 0 ? parseFloat(result.rows[0].balance) : 0;
  }

  /**
   * Update balance cache
   */
  async _updateBalanceCache(
    client,
    accountId,
    assetTypeId,
    newBalance,
    transactionId,
  ) {
    await client.query(
      `INSERT INTO balance_cache (account_id, asset_type_id, balance, last_transaction_id, updated_at)
             VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
             ON CONFLICT (account_id, asset_type_id)
             DO UPDATE SET 
                balance = EXCLUDED.balance,
                last_transaction_id = EXCLUDED.last_transaction_id,
                updated_at = CURRENT_TIMESTAMP`,
      [accountId, assetTypeId, newBalance, transactionId],
    );
  }

  /**
   * Create audit log entry
   */
  async _createAuditLog(client, transactionId, accountId, action, requestData) {
    await client.query(
      `INSERT INTO audit_log (transaction_id, account_id, action, request_data)
             VALUES ($1, $2, $3, $4)`,
      [transactionId, accountId, action, JSON.stringify(requestData)],
    );
  }

  /**
   * Hash request for idempotency checking
   */
  _hashRequest(data) {
    return crypto
      .createHash("sha256")
      .update(JSON.stringify(data))
      .digest("hex");
  }
}

module.exports = new TransactionService();
