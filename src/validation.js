const Joi = require('joi');

/**
 * Validation schemas for API requests
 * Using Joi for robust input validation
 */

const topUpSchema = Joi.object({
    userId: Joi.string().required().min(1).max(255)
        .messages({
            'string.empty': 'userId is required',
            'any.required': 'userId is required'
        }),
    assetCode: Joi.string().required().uppercase().max(50)
        .messages({
            'string.empty': 'assetCode is required',
            'any.required': 'assetCode is required'
        }),
    amount: Joi.number().positive().precision(8).required()
        .messages({
            'number.positive': 'amount must be positive',
            'any.required': 'amount is required'
        }),
    idempotencyKey: Joi.string().required().max(255)
        .messages({
            'string.empty': 'idempotencyKey is required',
            'any.required': 'idempotencyKey is required'
        }),
    metadata: Joi.object().optional().default({})
});

const bonusSchema = Joi.object({
    userId: Joi.string().required().min(1).max(255)
        .messages({
            'string.empty': 'userId is required',
            'any.required': 'userId is required'
        }),
    assetCode: Joi.string().required().uppercase().max(50)
        .messages({
            'string.empty': 'assetCode is required',
            'any.required': 'assetCode is required'
        }),
    amount: Joi.number().positive().precision(8).required()
        .messages({
            'number.positive': 'amount must be positive',
            'any.required': 'amount is required'
        }),
    idempotencyKey: Joi.string().required().max(255)
        .messages({
            'string.empty': 'idempotencyKey is required',
            'any.required': 'idempotencyKey is required'
        }),
    metadata: Joi.object({
        reason: Joi.string().optional(),
        campaign: Joi.string().optional(),
        referralCode: Joi.string().optional()
    }).optional().default({})
});

const purchaseSchema = Joi.object({
    userId: Joi.string().required().min(1).max(255)
        .messages({
            'string.empty': 'userId is required',
            'any.required': 'userId is required'
        }),
    assetCode: Joi.string().required().uppercase().max(50)
        .messages({
            'string.empty': 'assetCode is required',
            'any.required': 'assetCode is required'
        }),
    amount: Joi.number().positive().precision(8).required()
        .messages({
            'number.positive': 'amount must be positive',
            'any.required': 'amount is required'
        }),
    idempotencyKey: Joi.string().required().max(255)
        .messages({
            'string.empty': 'idempotencyKey is required',
            'any.required': 'idempotencyKey is required'
        }),
    metadata: Joi.object({
        itemId: Joi.string().optional(),
        itemName: Joi.string().optional(),
        itemType: Joi.string().optional(),
        quantity: Joi.number().integer().positive().optional()
    }).optional().default({})
});

const balanceQuerySchema = Joi.object({
    userId: Joi.string().required().min(1).max(255),
    assetCode: Joi.string().optional().uppercase().max(50)
});

const transactionHistorySchema = Joi.object({
    userId: Joi.string().required().min(1).max(255),
    limit: Joi.number().integer().min(1).max(100).optional().default(50),
    offset: Joi.number().integer().min(0).optional().default(0)
});

/**
 * Validation middleware
 */
function validate(schema) {
    return (req, res, next) => {
        const { error, value } = schema.validate(req.body, {
            abortEarly: false,
            stripUnknown: true
        });

        if (error) {
            const errors = error.details.map(detail => ({
                field: detail.path.join('.'),
                message: detail.message
            }));

            return res.status(400).json({
                success: false,
                error: 'Validation failed',
                details: errors
            });
        }

        // Replace body with validated and sanitized data
        req.body = value;
        next();
    };
}

function validateQuery(schema) {
    return (req, res, next) => {
        const { error, value } = schema.validate(req.query, {
            abortEarly: false,
            stripUnknown: true
        });

        if (error) {
            const errors = error.details.map(detail => ({
                field: detail.path.join('.'),
                message: detail.message
            }));

            return res.status(400).json({
                success: false,
                error: 'Validation failed',
                details: errors
            });
        }

        req.query = value;
        next();
    };
}

module.exports = {
    topUpSchema,
    bonusSchema,
    purchaseSchema,
    balanceQuerySchema,
    transactionHistorySchema,
    validate,
    validateQuery
};
