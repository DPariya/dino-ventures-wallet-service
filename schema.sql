-- ============================================================================
-- Dino Ventures Internal Wallet Service - Database Schema
-- Double-Entry Ledger System with ACID Compliance
-- ============================================================================

-- Enable UUID extension for generating unique identifiers
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- 1. ASSET TYPES TABLE
-- Defines the virtual currencies/assets in the system (Gold Coins, Diamonds, etc.)
-- ============================================================================
CREATE TABLE asset_types (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    decimals INTEGER DEFAULT 2,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_asset_types_code ON asset_types(code);
CREATE INDEX idx_asset_types_active ON asset_types(is_active) WHERE is_active = true;

-- ============================================================================
-- 2. ACCOUNT TYPES TABLE
-- Differentiates between user accounts, system accounts, revenue accounts, etc.
-- ============================================================================
CREATE TABLE account_types (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_account_types_code ON account_types(code);

-- ============================================================================
-- 3. ACCOUNTS TABLE
-- Represents all wallet accounts (users, system treasury, revenue pools)
-- No balance column - balances are calculated from ledger entries
-- ============================================================================
CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_type_id UUID NOT NULL REFERENCES account_types(id),
    user_id VARCHAR(255), -- NULL for system accounts
    email VARCHAR(255),
    name VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT true,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_accounts_user_id ON accounts(user_id);
CREATE INDEX idx_accounts_email ON accounts(email);
CREATE INDEX idx_accounts_type ON accounts(account_type_id);
CREATE INDEX idx_accounts_active ON accounts(is_active) WHERE is_active = true;

-- ============================================================================
-- 4. TRANSACTION TYPES TABLE
-- Defines different transaction categories (top-up, bonus, purchase, etc.)
-- ============================================================================
CREATE TABLE transaction_types (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_transaction_types_code ON transaction_types(code);

-- ============================================================================
-- 5. TRANSACTIONS TABLE
-- Master record for each transaction - ensures atomicity
-- Uses idempotency_key to prevent duplicate transactions
-- ============================================================================
CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    idempotency_key VARCHAR(255) UNIQUE NOT NULL,
    transaction_type_id UUID NOT NULL REFERENCES transaction_types(id),
    asset_type_id UUID NOT NULL REFERENCES asset_types(id),
    amount DECIMAL(20, 8) NOT NULL CHECK (amount > 0),
    description TEXT,
    metadata JSONB DEFAULT '{}',
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'reversed')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP
);

-- Critical index for idempotency checks - must be very fast
CREATE UNIQUE INDEX idx_transactions_idempotency ON transactions(idempotency_key);
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_created_at ON transactions(created_at DESC);
CREATE INDEX idx_transactions_asset_type ON transactions(asset_type_id);

-- ============================================================================
-- 6. LEDGER ENTRIES TABLE (Double-Entry Accounting)
-- Every transaction creates TWO entries: one debit, one credit
-- This ensures the accounting equation always balances
-- ============================================================================
CREATE TABLE ledger_entries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id UUID NOT NULL REFERENCES transactions(id),
    account_id UUID NOT NULL REFERENCES accounts(id),
    asset_type_id UUID NOT NULL REFERENCES asset_types(id),
    entry_type VARCHAR(10) NOT NULL CHECK (entry_type IN ('debit', 'credit')),
    amount DECIMAL(20, 8) NOT NULL CHECK (amount > 0),
    running_balance DECIMAL(20, 8) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Performance-critical indexes for balance calculations
CREATE INDEX idx_ledger_account_asset ON ledger_entries(account_id, asset_type_id);
CREATE INDEX idx_ledger_transaction ON ledger_entries(transaction_id);
CREATE INDEX idx_ledger_created_at ON ledger_entries(created_at DESC);
CREATE INDEX idx_ledger_account_created ON ledger_entries(account_id, created_at DESC);

-- Composite index for fast balance queries
CREATE INDEX idx_ledger_balance_query ON ledger_entries(account_id, asset_type_id, created_at DESC);

-- ============================================================================
-- 7. BALANCE CACHE TABLE (Performance Optimization)
-- Materialized view of current balances to avoid summing millions of ledger entries
-- Updated atomically within the same transaction that creates ledger entries
-- ============================================================================
CREATE TABLE balance_cache (
    account_id UUID NOT NULL REFERENCES accounts(id),
    asset_type_id UUID NOT NULL REFERENCES asset_types(id),
    balance DECIMAL(20, 8) DEFAULT 0 CHECK (balance >= 0),
    last_transaction_id UUID REFERENCES transactions(id),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, asset_type_id)
);

CREATE INDEX idx_balance_cache_account ON balance_cache(account_id);
CREATE INDEX idx_balance_cache_updated ON balance_cache(updated_at DESC);

-- ============================================================================
-- 8. IDEMPOTENCY LOG TABLE
-- Tracks processed idempotency keys with their responses
-- Prevents duplicate processing of requests
-- ============================================================================
CREATE TABLE idempotency_log (
    idempotency_key VARCHAR(255) PRIMARY KEY,
    request_hash VARCHAR(64) NOT NULL,
    response_data JSONB,
    status VARCHAR(20) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL
);

CREATE INDEX idx_idempotency_expires ON idempotency_log(expires_at);

-- ============================================================================
-- 9. AUDIT LOG TABLE
-- Complete audit trail for compliance and debugging
-- ============================================================================
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id UUID REFERENCES transactions(id),
    account_id UUID REFERENCES accounts(id),
    action VARCHAR(100) NOT NULL,
    actor VARCHAR(255),
    ip_address INET,
    user_agent TEXT,
    request_data JSONB,
    response_data JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_transaction ON audit_log(transaction_id);
CREATE INDEX idx_audit_account ON audit_log(account_id);
CREATE INDEX idx_audit_created_at ON audit_log(created_at DESC);

-- ============================================================================
-- STORED FUNCTIONS FOR DEADLOCK AVOIDANCE
-- ============================================================================

-- Function to lock accounts in deterministic order (prevents circular wait)
CREATE OR REPLACE FUNCTION lock_accounts_ordered(account_ids UUID[])
RETURNS VOID AS $$
DECLARE
    sorted_ids UUID[];
BEGIN
    -- Sort account IDs to ensure consistent lock ordering
    sorted_ids := ARRAY(SELECT unnest(account_ids) ORDER BY 1);
    
    -- Lock accounts in sorted order
    PERFORM * FROM accounts 
    WHERE id = ANY(sorted_ids)
    ORDER BY id
    FOR UPDATE NOWAIT;
END;
$$ LANGUAGE plpgsql;

-- Function to get current balance efficiently
CREATE OR REPLACE FUNCTION get_account_balance(
    p_account_id UUID,
    p_asset_type_id UUID
)
RETURNS DECIMAL(20, 8) AS $$
DECLARE
    current_balance DECIMAL(20, 8);
BEGIN
    SELECT balance INTO current_balance
    FROM balance_cache
    WHERE account_id = p_account_id AND asset_type_id = p_asset_type_id;
    
    RETURN COALESCE(current_balance, 0);
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- TRIGGERS FOR AUTOMATIC TIMESTAMP UPDATES
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_asset_types_updated_at
    BEFORE UPDATE ON asset_types
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_accounts_updated_at
    BEFORE UPDATE ON accounts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- CONSTRAINT TO ENSURE DOUBLE-ENTRY BALANCE
-- This can be verified with a periodic job checking:
-- SUM(CASE WHEN entry_type = 'debit' THEN amount ELSE -amount END) = 0
-- for each transaction_id
-- ============================================================================

COMMENT ON TABLE ledger_entries IS 'Double-entry ledger: every transaction must have equal debits and credits';
COMMENT ON TABLE balance_cache IS 'Performance cache: updated atomically with ledger entries to avoid slow aggregations';
COMMENT ON TABLE transactions IS 'Transaction master: idempotency_key ensures exactly-once processing';
