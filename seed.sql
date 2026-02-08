-- ============================================================================
-- SEED DATA FOR DINO VENTURES WALLET SERVICE
-- This script populates initial data required for the system to function
-- ============================================================================

-- ============================================================================
-- 1. SEED ASSET TYPES
-- ============================================================================
INSERT INTO asset_types (code, name, description, decimals, is_active) VALUES
    ('GOLD_COIN', 'Gold Coins', 'Primary gaming currency for in-game purchases', 2, true),
    ('DIAMOND', 'Diamonds', 'Premium currency for exclusive items and features', 2, true),
    ('LOYALTY_POINT', 'Loyalty Points', 'Reward points earned through gameplay and engagement', 0, true),
    ('ENERGY', 'Energy', 'Resource for playing games and challenges', 0, true);

-- ============================================================================
-- 2. SEED ACCOUNT TYPES
-- ============================================================================
INSERT INTO account_types (code, name, description) VALUES
    ('USER', 'User Account', 'Individual player wallet account'),
    ('SYSTEM_TREASURY', 'System Treasury', 'Central treasury for issuing and receiving currency'),
    ('SYSTEM_REVENUE', 'System Revenue', 'Revenue collection account for purchases'),
    ('SYSTEM_BONUS', 'Bonus Pool', 'Pool for distributing bonuses and incentives'),
    ('SYSTEM_RESERVE', 'Reserve Fund', 'Emergency reserve and float management');

-- ============================================================================
-- 3. SEED SYSTEM ACCOUNTS
-- ============================================================================

-- Get account type IDs
DO $$
DECLARE
    treasury_type_id UUID;
    revenue_type_id UUID;
    bonus_type_id UUID;
    reserve_type_id UUID;
    user_type_id UUID;
BEGIN
    SELECT id INTO treasury_type_id FROM account_types WHERE code = 'SYSTEM_TREASURY';
    SELECT id INTO revenue_type_id FROM account_types WHERE code = 'SYSTEM_REVENUE';
    SELECT id INTO bonus_type_id FROM account_types WHERE code = 'SYSTEM_BONUS';
    SELECT id INTO reserve_type_id FROM account_types WHERE code = 'SYSTEM_RESERVE';
    SELECT id INTO user_type_id FROM account_types WHERE code = 'USER';

    -- System Treasury Account
    INSERT INTO accounts (account_type_id, user_id, name, email, metadata) VALUES
        (treasury_type_id, NULL, 'System Treasury', 'treasury@dinoventures.com', 
         '{"purpose": "Central bank for currency issuance", "critical": true}');

    -- System Revenue Account
    INSERT INTO accounts (account_type_id, user_id, name, email, metadata) VALUES
        (revenue_type_id, NULL, 'Revenue Collection', 'revenue@dinoventures.com',
         '{"purpose": "Collects all user purchases", "critical": true}');

    -- Bonus Pool Account
    INSERT INTO accounts (account_type_id, user_id, name, email, metadata) VALUES
        (bonus_type_id, NULL, 'Bonus & Incentive Pool', 'bonus@dinoventures.com',
         '{"purpose": "Distributes promotional bonuses", "critical": true}');

    -- Reserve Fund Account
    INSERT INTO accounts (account_type_id, user_id, name, email, metadata) VALUES
        (reserve_type_id, NULL, 'Reserve Fund', 'reserve@dinoventures.com',
         '{"purpose": "Emergency reserves", "critical": true}');

    -- ========================================================================
    -- 4. SEED USER ACCOUNTS (Test Users)
    -- ========================================================================
    INSERT INTO accounts (account_type_id, user_id, name, email, metadata) VALUES
        (user_type_id, 'user_001', 'Alex Morgan', 'alex.morgan@example.com',
         '{"level": 15, "region": "NA", "verified": true, "joined": "2024-01-15"}'),
        (user_type_id, 'user_002', 'Sarah Chen', 'sarah.chen@example.com',
         '{"level": 28, "region": "APAC", "verified": true, "joined": "2023-11-20"}'),
        (user_type_id, 'user_003', 'Marcus Johnson', 'marcus.j@example.com',
         '{"level": 42, "region": "EU", "verified": true, "joined": "2023-08-05"}'),
        (user_type_id, 'user_004', 'Emma Rodriguez', 'emma.r@example.com',
         '{"level": 7, "region": "LATAM", "verified": true, "joined": "2024-12-01"}');
END $$;

-- ============================================================================
-- 5. SEED TRANSACTION TYPES
-- ============================================================================
INSERT INTO transaction_types (code, name, description) VALUES
    ('TOP_UP', 'Wallet Top-up', 'User purchases credits with real money'),
    ('BONUS', 'Bonus/Incentive', 'System issues free credits (referral, promotion, etc.)'),
    ('PURCHASE', 'In-app Purchase', 'User spends credits on items/services'),
    ('REFUND', 'Refund', 'Credits returned to user'),
    ('ADJUSTMENT', 'Manual Adjustment', 'Administrative correction'),
    ('REWARD', 'Achievement Reward', 'Credits earned through gameplay'),
    ('TRANSFER_IN', 'Transfer In', 'Credits received from another account'),
    ('TRANSFER_OUT', 'Transfer Out', 'Credits sent to another account');

-- ============================================================================
-- 6. INITIALIZE SYSTEM ACCOUNTS WITH STARTING BALANCES
-- This seeds the system treasury with sufficient float
-- ============================================================================

DO $$
DECLARE
    treasury_account_id UUID;
    bonus_account_id UUID;
    gold_coin_id UUID;
    diamond_id UUID;
    loyalty_point_id UUID;
    energy_id UUID;
    init_transaction_id UUID;
    adjustment_type_id UUID;
BEGIN
    -- Get account IDs
    SELECT id INTO treasury_account_id FROM accounts WHERE name = 'System Treasury';
    SELECT id INTO bonus_account_id FROM accounts WHERE name = 'Bonus & Incentive Pool';
    
    -- Get asset type IDs
    SELECT id INTO gold_coin_id FROM asset_types WHERE code = 'GOLD_COIN';
    SELECT id INTO diamond_id FROM asset_types WHERE code = 'DIAMOND';
    SELECT id INTO loyalty_point_id FROM asset_types WHERE code = 'LOYALTY_POINT';
    SELECT id INTO energy_id FROM asset_types WHERE code = 'ENERGY';
    
    -- Get transaction type
    SELECT id INTO adjustment_type_id FROM transaction_types WHERE code = 'ADJUSTMENT';

    -- Initialize Treasury with large float for Gold Coins
    init_transaction_id := uuid_generate_v4();
    INSERT INTO transactions (id, idempotency_key, transaction_type_id, asset_type_id, amount, description, status, completed_at)
    VALUES (init_transaction_id, 'INIT_TREASURY_GOLD_' || init_transaction_id, adjustment_type_id, gold_coin_id, 10000000.00,
            'Initial treasury float for Gold Coins', 'completed', CURRENT_TIMESTAMP);
    
    INSERT INTO ledger_entries (transaction_id, account_id, asset_type_id, entry_type, amount, running_balance, description)
    VALUES (init_transaction_id, treasury_account_id, gold_coin_id, 'credit', 10000000.00, 10000000.00,
            'Initial treasury balance');
    
    INSERT INTO balance_cache (account_id, asset_type_id, balance, last_transaction_id)
    VALUES (treasury_account_id, gold_coin_id, 10000000.00, init_transaction_id);

    -- Initialize Treasury with Diamonds
    init_transaction_id := uuid_generate_v4();
    INSERT INTO transactions (id, idempotency_key, transaction_type_id, asset_type_id, amount, description, status, completed_at)
    VALUES (init_transaction_id, 'INIT_TREASURY_DIAMOND_' || init_transaction_id, adjustment_type_id, diamond_id, 5000000.00,
            'Initial treasury float for Diamonds', 'completed', CURRENT_TIMESTAMP);
    
    INSERT INTO ledger_entries (transaction_id, account_id, asset_type_id, entry_type, amount, running_balance, description)
    VALUES (init_transaction_id, treasury_account_id, diamond_id, 'credit', 5000000.00, 5000000.00,
            'Initial treasury balance');
    
    INSERT INTO balance_cache (account_id, asset_type_id, balance, last_transaction_id)
    VALUES (treasury_account_id, diamond_id, 5000000.00, init_transaction_id);

    -- Initialize Bonus Pool with Gold Coins
    init_transaction_id := uuid_generate_v4();
    INSERT INTO transactions (id, idempotency_key, transaction_type_id, asset_type_id, amount, description, status, completed_at)
    VALUES (init_transaction_id, 'INIT_BONUS_GOLD_' || init_transaction_id, adjustment_type_id, gold_coin_id, 1000000.00,
            'Initial bonus pool for Gold Coins', 'completed', CURRENT_TIMESTAMP);
    
    INSERT INTO ledger_entries (transaction_id, account_id, asset_type_id, entry_type, amount, running_balance, description)
    VALUES (init_transaction_id, bonus_account_id, gold_coin_id, 'credit', 1000000.00, 1000000.00,
            'Initial bonus pool balance');
    
    INSERT INTO balance_cache (account_id, asset_type_id, balance, last_transaction_id)
    VALUES (bonus_account_id, gold_coin_id, 1000000.00, init_transaction_id);

    -- Initialize Bonus Pool with Loyalty Points
    init_transaction_id := uuid_generate_v4();
    INSERT INTO transactions (id, idempotency_key, transaction_type_id, asset_type_id, amount, description, status, completed_at)
    VALUES (init_transaction_id, 'INIT_BONUS_LOYALTY_' || init_transaction_id, adjustment_type_id, loyalty_point_id, 5000000,
            'Initial bonus pool for Loyalty Points', 'completed', CURRENT_TIMESTAMP);
    
    INSERT INTO ledger_entries (transaction_id, account_id, asset_type_id, entry_type, amount, running_balance, description)
    VALUES (init_transaction_id, bonus_account_id, loyalty_point_id, 'credit', 5000000, 5000000,
            'Initial bonus pool balance');
    
    INSERT INTO balance_cache (account_id, asset_type_id, balance, last_transaction_id)
    VALUES (bonus_account_id, loyalty_point_id, 5000000, init_transaction_id);
END $$;

-- ============================================================================
-- 7. SEED INITIAL USER BALANCES
-- Give test users some starting balance for testing
-- ============================================================================

DO $$
DECLARE
    user1_id UUID;
    user2_id UUID;
    treasury_id UUID;
    gold_coin_id UUID;
    diamond_id UUID;
    loyalty_point_id UUID;
    topup_type_id UUID;
    txn_id UUID;
BEGIN
    -- Get account IDs
    SELECT id INTO user1_id FROM accounts WHERE user_id = 'user_001';
    SELECT id INTO user2_id FROM accounts WHERE user_id = 'user_002';
    SELECT id INTO treasury_id FROM accounts WHERE name = 'System Treasury';
    
    -- Get asset type IDs
    SELECT id INTO gold_coin_id FROM asset_types WHERE code = 'GOLD_COIN';
    SELECT id INTO diamond_id FROM asset_types WHERE code = 'DIAMOND';
    SELECT id INTO loyalty_point_id FROM asset_types WHERE code = 'LOYALTY_POINT';
    
    -- Get transaction type
    SELECT id INTO topup_type_id FROM transaction_types WHERE code = 'TOP_UP';

    -- Give User 1: 500 Gold Coins
    txn_id := uuid_generate_v4();
    INSERT INTO transactions (id, idempotency_key, transaction_type_id, asset_type_id, amount, description, status, completed_at)
    VALUES (txn_id, 'SEED_USER1_GOLD_' || txn_id, topup_type_id, gold_coin_id, 500.00,
            'Initial balance for test user Alex Morgan', 'completed', CURRENT_TIMESTAMP);
    
    -- Debit from treasury
    INSERT INTO ledger_entries (transaction_id, account_id, asset_type_id, entry_type, amount, running_balance)
    VALUES (txn_id, treasury_id, gold_coin_id, 'debit', 500.00, 9999500.00);
    
    -- Credit to user
    INSERT INTO ledger_entries (transaction_id, account_id, asset_type_id, entry_type, amount, running_balance)
    VALUES (txn_id, user1_id, gold_coin_id, 'credit', 500.00, 500.00);
    
    -- Update balance cache
    UPDATE balance_cache SET balance = 9999500.00, last_transaction_id = txn_id 
    WHERE account_id = treasury_id AND asset_type_id = gold_coin_id;
    
    INSERT INTO balance_cache (account_id, asset_type_id, balance, last_transaction_id)
    VALUES (user1_id, gold_coin_id, 500.00, txn_id);

    -- Give User 1: 50 Diamonds
    txn_id := uuid_generate_v4();
    INSERT INTO transactions (id, idempotency_key, transaction_type_id, asset_type_id, amount, description, status, completed_at)
    VALUES (txn_id, 'SEED_USER1_DIAMOND_' || txn_id, topup_type_id, diamond_id, 50.00,
            'Initial diamonds for test user Alex Morgan', 'completed', CURRENT_TIMESTAMP);
    
    INSERT INTO ledger_entries (transaction_id, account_id, asset_type_id, entry_type, amount, running_balance)
    VALUES (txn_id, treasury_id, diamond_id, 'debit', 50.00, 4999950.00);
    
    INSERT INTO ledger_entries (transaction_id, account_id, asset_type_id, entry_type, amount, running_balance)
    VALUES (txn_id, user1_id, diamond_id, 'credit', 50.00, 50.00);
    
    UPDATE balance_cache SET balance = 4999950.00, last_transaction_id = txn_id 
    WHERE account_id = treasury_id AND asset_type_id = diamond_id;
    
    INSERT INTO balance_cache (account_id, asset_type_id, balance, last_transaction_id)
    VALUES (user1_id, diamond_id, 50.00, txn_id);

    -- Give User 2: 1200 Gold Coins
    txn_id := uuid_generate_v4();
    INSERT INTO transactions (id, idempotency_key, transaction_type_id, asset_type_id, amount, description, status, completed_at)
    VALUES (txn_id, 'SEED_USER2_GOLD_' || txn_id, topup_type_id, gold_coin_id, 1200.00,
            'Initial balance for test user Sarah Chen', 'completed', CURRENT_TIMESTAMP);
    
    INSERT INTO ledger_entries (transaction_id, account_id, asset_type_id, entry_type, amount, running_balance)
    VALUES (txn_id, treasury_id, gold_coin_id, 'debit', 1200.00, 9998300.00);
    
    INSERT INTO ledger_entries (transaction_id, account_id, asset_type_id, entry_type, amount, running_balance)
    VALUES (txn_id, user2_id, gold_coin_id, 'credit', 1200.00, 1200.00);
    
    UPDATE balance_cache SET balance = 9998300.00, last_transaction_id = txn_id 
    WHERE account_id = treasury_id AND asset_type_id = gold_coin_id;
    
    INSERT INTO balance_cache (account_id, asset_type_id, balance, last_transaction_id)
    VALUES (user2_id, gold_coin_id, 1200.00, txn_id);

    -- Give User 2: 250 Loyalty Points
    txn_id := uuid_generate_v4();
    INSERT INTO transactions (id, idempotency_key, transaction_type_id, asset_type_id, amount, description, status, completed_at)
    VALUES (txn_id, 'SEED_USER2_LOYALTY_' || txn_id, topup_type_id, loyalty_point_id, 250,
            'Initial loyalty points for test user Sarah Chen', 'completed', CURRENT_TIMESTAMP);
    
    -- Note: Loyalty points come from bonus pool, not treasury
    DECLARE bonus_id UUID;
    BEGIN
        SELECT id INTO bonus_id FROM accounts WHERE name = 'Bonus & Incentive Pool';
        
        INSERT INTO ledger_entries (transaction_id, account_id, asset_type_id, entry_type, amount, running_balance)
        VALUES (txn_id, bonus_id, loyalty_point_id, 'debit', 250, 4999750);
        
        INSERT INTO ledger_entries (transaction_id, account_id, asset_type_id, entry_type, amount, running_balance)
        VALUES (txn_id, user2_id, loyalty_point_id, 'credit', 250, 250);
        
        UPDATE balance_cache SET balance = 4999750, last_transaction_id = txn_id 
        WHERE account_id = bonus_id AND asset_type_id = loyalty_point_id;
        
        INSERT INTO balance_cache (account_id, asset_type_id, balance, last_transaction_id)
        VALUES (user2_id, loyalty_point_id, 250, txn_id);
    END;
END $$;

-- ============================================================================
-- VERIFICATION QUERIES
-- Run these to verify the seed data loaded correctly
-- ============================================================================

-- Verify all asset types
SELECT code, name, is_active FROM asset_types ORDER BY code;

-- Verify all accounts
SELECT a.name, at.name as account_type, a.user_id, a.email 
FROM accounts a 
JOIN account_types at ON a.account_type_id = at.id 
ORDER BY at.code, a.name;

-- Verify balances
SELECT 
    a.name as account_name,
    at.name as asset_name,
    bc.balance
FROM balance_cache bc
JOIN accounts a ON bc.account_id = a.id
JOIN asset_types at ON bc.asset_type_id = at.id
ORDER BY a.name, at.name;

-- Verify double-entry balance (should be 0 for all transactions)
SELECT 
    t.idempotency_key,
    t.description,
    SUM(CASE WHEN le.entry_type = 'debit' THEN le.amount ELSE -le.amount END) as balance_check
FROM transactions t
JOIN ledger_entries le ON t.id = le.transaction_id
GROUP BY t.id, t.idempotency_key, t.description
HAVING SUM(CASE WHEN le.entry_type = 'debit' THEN le.amount ELSE -le.amount END) != 0;

-- Show transaction count
SELECT COUNT(*) as total_transactions FROM transactions;
SELECT COUNT(*) as total_ledger_entries FROM ledger_entries;
