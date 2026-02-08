const { Pool } = require('pg');
const logger = require('./logger');

// Database connection pool configuration
// Optimized for high-concurrency workloads with proper connection management
const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'wallet_service',
    user: process.env.DB_USER || 'wallet_admin',
    password: process.env.DB_PASSWORD,
    
    // Connection pool settings for high traffic
    min: parseInt(process.env.DB_POOL_MIN || '10'),
    max: parseInt(process.env.DB_POOL_MAX || '50'),
    
    // Timeout configurations
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '30000'),
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT_MS || '10000'),
    
    // Statement timeout to prevent long-running queries
    statement_timeout: 30000,
    
    // Keepalive settings for stable connections
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
});

// Handle pool errors to prevent crashes
pool.on('error', (err, client) => {
    logger.error('Unexpected error on idle database client', {
        error: err.message,
        stack: err.stack
    });
});

// Connection health check
pool.on('connect', (client) => {
    logger.debug('New database client connected');
});

pool.on('acquire', (client) => {
    logger.debug('Database client acquired from pool');
});

pool.on('remove', (client) => {
    logger.debug('Database client removed from pool');
});

/**
 * Test database connectivity
 * @returns {Promise<boolean>}
 */
async function testConnection() {
    try {
        const client = await pool.connect();
        const result = await client.query('SELECT NOW() as current_time, version() as db_version');
        client.release();
        
        logger.info('Database connection successful', {
            timestamp: result.rows[0].current_time,
            version: result.rows[0].db_version
        });
        
        return true;
    } catch (error) {
        logger.error('Database connection failed', {
            error: error.message,
            stack: error.stack
        });
        return false;
    }
}

/**
 * Execute a query with automatic retry on deadlock
 * @param {Function} queryFunction - Async function that executes the query
 * @param {number} maxRetries - Maximum number of retry attempts
 * @returns {Promise<any>}
 */
async function executeWithRetry(queryFunction, maxRetries = 3) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await queryFunction();
        } catch (error) {
            lastError = error;
            
            // Check if error is a deadlock (PostgreSQL error code 40P01)
            // or serialization failure (40001)
            const isRetriable = error.code === '40P01' || 
                               error.code === '40001' ||
                               error.code === '55P03'; // lock_not_available (NOWAIT)
            
            if (!isRetriable || attempt === maxRetries) {
                throw error;
            }
            
            // Exponential backoff with jitter
            const baseDelay = parseInt(process.env.RETRY_DELAY_MS || '100');
            const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 100;
            
            logger.warn('Retrying query due to deadlock or serialization failure', {
                attempt,
                maxRetries,
                errorCode: error.code,
                delayMs: Math.round(delay)
            });
            
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    throw lastError;
}

/**
 * Graceful shutdown of database pool
 */
async function shutdown() {
    try {
        await pool.end();
        logger.info('Database pool closed successfully');
    } catch (error) {
        logger.error('Error closing database pool', {
            error: error.message
        });
    }
}

module.exports = {
    pool,
    testConnection,
    executeWithRetry,
    shutdown
};
