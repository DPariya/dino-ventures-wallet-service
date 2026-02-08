require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'wallet_service',
    user: process.env.DB_USER || 'wallet_admin',
    password: process.env.DB_PASSWORD
});

async function runSeed() {
    const client = await pool.connect();
    
    try {
        console.log('========================================');
        console.log('Starting database seeding process...');
        console.log('========================================\n');

        // Read schema file
        console.log('📄 Loading schema.sql...');
        const schemaPath = path.join(__dirname, '..', '..', 'schema.sql');
        const schemaSQL = fs.readFileSync(schemaPath, 'utf8');
        
        // Read seed file
        console.log('📄 Loading seed.sql...');
        const seedPath = path.join(__dirname, '..', '..', 'seed.sql');
        const seedSQL = fs.readFileSync(seedPath, 'utf8');

        // Execute schema
        console.log('\n🔨 Creating database schema...');
        await client.query(schemaSQL);
        console.log('✅ Schema created successfully');

        // Execute seed data
        console.log('\n🌱 Seeding initial data...');
        await client.query(seedSQL);
        console.log('✅ Data seeded successfully');

        // Verify seeding
        console.log('\n🔍 Verifying seed data...\n');

        // Check asset types
        const assetResult = await client.query('SELECT COUNT(*) as count FROM asset_types');
        console.log(`   Asset Types: ${assetResult.rows[0].count}`);

        // Check accounts
        const accountResult = await client.query('SELECT COUNT(*) as count FROM accounts');
        console.log(`   Accounts: ${accountResult.rows[0].count}`);

        // Check transactions
        const txnResult = await client.query('SELECT COUNT(*) as count FROM transactions');
        console.log(`   Transactions: ${txnResult.rows[0].count}`);

        // Check ledger entries
        const ledgerResult = await client.query('SELECT COUNT(*) as count FROM ledger_entries');
        console.log(`   Ledger Entries: ${ledgerResult.rows[0].count}`);

        // Check balance cache
        const balanceResult = await client.query('SELECT COUNT(*) as count FROM balance_cache');
        console.log(`   Balance Cache Entries: ${balanceResult.rows[0].count}`);

        // Display sample balances
        console.log('\n📊 Sample User Balances:');
        const balances = await client.query(`
            SELECT 
                a.name,
                at.code as asset,
                bc.balance
            FROM balance_cache bc
            JOIN accounts a ON bc.account_id = a.id
            JOIN asset_types at ON bc.asset_type_id = at.id
            WHERE a.user_id IS NOT NULL
            ORDER BY a.name, at.code
        `);

        balances.rows.forEach(row => {
            console.log(`   ${row.name}: ${row.balance} ${row.asset}`);
        });

        console.log('\n========================================');
        console.log('✨ Database seeding completed successfully!');
        console.log('========================================');

    } catch (error) {
        console.error('\n❌ Error during seeding:', error.message);
        console.error(error.stack);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

// Run the seed function
runSeed();
