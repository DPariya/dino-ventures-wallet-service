const express = require('express');
const transactionService = require('./transactionService');
const logger = require('./logger');
const {
    topUpSchema,
    bonusSchema,
    purchaseSchema,
    balanceQuerySchema,
    transactionHistorySchema,
    validate,
    validateQuery
} = require('./validation');

const router = express.Router();

/**
 * Health check endpoint
 */
router.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

/**
 * POST /api/transactions/topup
 * Top up user wallet (purchase credits with real money)
 * 
 * Request body:
 * {
 *   "userId": "user_001",
 *   "assetCode": "GOLD_COIN",
 *   "amount": 100.00,
 *   "idempotencyKey": "unique-key-123",
 *   "metadata": {
 *     "paymentId": "pay_xyz",
 *     "paymentMethod": "credit_card"
 *   }
 * }
 */
router.post('/transactions/topup', validate(topUpSchema), async (req, res) => {
    try {
        const { userId, assetCode, amount, idempotencyKey, metadata } = req.body;

        logger.info('Received top-up request', {
            userId,
            assetCode,
            amount,
            idempotencyKey,
            ip: req.ip
        });

        const result = await transactionService.topUp(
            userId,
            assetCode,
            amount,
            idempotencyKey,
            metadata
        );

        res.status(200).json({
            success: true,
            data: result
        });

    } catch (error) {
        logger.error('Top-up request failed', {
            error: error.message,
            body: req.body
        });

        const statusCode = error.message.includes('not found') ? 404 :
                          error.message.includes('Insufficient') ? 400 : 500;

        res.status(statusCode).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/transactions/bonus
 * Issue bonus/incentive credits to user
 * 
 * Request body:
 * {
 *   "userId": "user_001",
 *   "assetCode": "LOYALTY_POINT",
 *   "amount": 50,
 *   "idempotencyKey": "unique-key-456",
 *   "metadata": {
 *     "reason": "Referral bonus",
 *     "campaign": "spring_2024"
 *   }
 * }
 */
router.post('/transactions/bonus', validate(bonusSchema), async (req, res) => {
    try {
        const { userId, assetCode, amount, idempotencyKey, metadata } = req.body;

        logger.info('Received bonus request', {
            userId,
            assetCode,
            amount,
            idempotencyKey,
            reason: metadata.reason
        });

        const result = await transactionService.issueBonus(
            userId,
            assetCode,
            amount,
            idempotencyKey,
            metadata
        );

        res.status(200).json({
            success: true,
            data: result
        });

    } catch (error) {
        logger.error('Bonus request failed', {
            error: error.message,
            body: req.body
        });

        const statusCode = error.message.includes('not found') ? 404 :
                          error.message.includes('Insufficient') ? 400 : 500;

        res.status(statusCode).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/transactions/purchase
 * User spends credits on in-app items/services
 * 
 * Request body:
 * {
 *   "userId": "user_001",
 *   "assetCode": "GOLD_COIN",
 *   "amount": 25.00,
 *   "idempotencyKey": "unique-key-789",
 *   "metadata": {
 *     "itemId": "sword_legendary_001",
 *     "itemName": "Legendary Sword of Fire",
 *     "itemType": "weapon"
 *   }
 * }
 */
router.post('/transactions/purchase', validate(purchaseSchema), async (req, res) => {
    try {
        const { userId, assetCode, amount, idempotencyKey, metadata } = req.body;

        logger.info('Received purchase request', {
            userId,
            assetCode,
            amount,
            idempotencyKey,
            item: metadata.itemName || metadata.itemId
        });

        const result = await transactionService.purchase(
            userId,
            assetCode,
            amount,
            idempotencyKey,
            metadata
        );

        res.status(200).json({
            success: true,
            data: result
        });

    } catch (error) {
        logger.error('Purchase request failed', {
            error: error.message,
            body: req.body
        });

        const statusCode = error.message.includes('not found') ? 404 :
                          error.message.includes('Insufficient balance') ? 400 : 500;

        res.status(statusCode).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/balance/:userId
 * Get user's balance for a specific asset or all assets
 * 
 * Query params:
 * - assetCode (optional): specific asset to query
 */
router.get('/balance/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { assetCode } = req.query;

        logger.info('Received balance query', {
            userId,
            assetCode
        });

        let result;
        if (assetCode) {
            result = await transactionService.getBalance(userId, assetCode);
        } else {
            result = await transactionService.getAllBalances(userId);
        }

        res.status(200).json({
            success: true,
            data: result
        });

    } catch (error) {
        logger.error('Balance query failed', {
            error: error.message,
            userId: req.params.userId
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/transactions/:userId
 * Get transaction history for a user
 * 
 * Query params:
 * - limit (optional, default 50): number of transactions to return
 * - offset (optional, default 0): pagination offset
 */
router.get('/transactions/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { limit = 50, offset = 0 } = req.query;

        logger.info('Received transaction history query', {
            userId,
            limit,
            offset
        });

        const result = await transactionService.getTransactionHistory(
            userId,
            parseInt(limit),
            parseInt(offset)
        );

        res.status(200).json({
            success: true,
            data: result
        });

    } catch (error) {
        logger.error('Transaction history query failed', {
            error: error.message,
            userId: req.params.userId
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Error handling for undefined routes
 */
router.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Route not found'
    });
});

module.exports = router;
