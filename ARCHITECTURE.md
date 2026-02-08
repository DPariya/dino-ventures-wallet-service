# System Architecture

## Overview

The Dino Ventures Wallet Service is designed to handle millions of concurrent users with ACID compliance, zero data loss, and high availability.

## System Design Principles

### 1. ACID Compliance

Every transaction in the system follows ACID properties:

- **Atomicity**: Each transaction either completes fully or not at all. We use PostgreSQL transactions with explicit BEGIN/COMMIT/ROLLBACK.
- **Consistency**: Double-entry ledger ensures debits always equal credits. Balance cache is updated atomically within transactions.
- **Isolation**: SERIALIZABLE isolation level prevents phantom reads and ensures linearizability.
- **Durability**: PostgreSQL's WAL (Write-Ahead Logging) ensures committed transactions survive crashes.

```javascript
await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
try {
    // All operations happen here
    await client.query('COMMIT');
} catch (error) {
    await client.query('ROLLBACK');
    throw error;
}
```

### 2. Concurrency Control

#### Problem: Race Conditions

When multiple transactions operate on the same account simultaneously:

```
Transaction A: Read balance = 100
Transaction B: Read balance = 100
Transaction A: Write balance = 150 (added 50)
Transaction B: Write balance = 120 (added 20)
Result: Balance = 120 (50 credits lost!)
```

#### Solution: Row-Level Locking with SERIALIZABLE Isolation

```javascript
// Lock accounts in deterministic order
const accountIds = [userAccount, systemAccount].sort();
await client.query(
    'SELECT * FROM accounts WHERE id = ANY($1) ORDER BY id FOR UPDATE NOWAIT',
    [accountIds]
);
```

Benefits:
- Locks acquired in consistent order (prevents deadlocks)
- NOWAIT fails fast if lock unavailable (enables retry)
- SERIALIZABLE isolation prevents lost updates

### 3. Deadlock Prevention

#### Deadlock Scenario

```
Transaction A: Locks Account 1 → Waits for Account 2
Transaction B: Locks Account 2 → Waits for Account 1
Result: Deadlock! Both transactions wait forever.
```

#### Solution: Deterministic Lock Ordering

Always lock resources in the same order (sorted by UUID):

```javascript
// WRONG: Can deadlock
lock(userAccount);
lock(systemAccount);

// CORRECT: Always sorts first
const sorted = [userAccount, systemAccount].sort();
sorted.forEach(account => lock(account));
```

This eliminates circular wait conditions.

### 4. Idempotency

Network requests can be duplicated (retries, client issues, etc.). We prevent duplicate processing:

```javascript
// Check if request already processed
const existing = await checkIdempotency(idempotencyKey);
if (existing) {
    return existing.response; // Return cached result
}

// Process new request
const result = await processTransaction();

// Cache result for 24 hours
await cacheIdempotencyResult(idempotencyKey, result);
```

### 5. Double-Entry Ledger

Every transaction creates exactly two ledger entries that balance:

```
Top-up 100 Gold Coins:
├─ Debit:  System Treasury → -100
└─ Credit: User Account    → +100
           Total Change:      0

Mathematical invariant: Σ debits = Σ credits
```

Benefits:
- Complete audit trail
- Can reconstruct any balance at any point in time
- Detects data corruption (unbalanced transactions)
- Regulatory compliance ready

### 6. Balance Cache

#### Why Cache?

Calculating balance from ledger entries is expensive:

```sql
-- Slow: Sum millions of entries
SELECT SUM(
    CASE WHEN entry_type = 'credit' THEN amount 
    ELSE -amount END
) FROM ledger_entries 
WHERE account_id = '...' AND asset_type_id = '...';
```

#### Solution: Materialized Balance

```sql
-- Fast: Single row lookup
SELECT balance FROM balance_cache 
WHERE account_id = '...' AND asset_type_id = '...';
```

Updated atomically in the same transaction:

```javascript
// Create ledger entry
await client.query('INSERT INTO ledger_entries ...');

// Update cache (same transaction)
await client.query('UPDATE balance_cache SET balance = $1 ...', [newBalance]);

// Both succeed or both fail together
await client.query('COMMIT');
```

## Data Flow

### Top-up Transaction Flow

```
1. Client Request
   ↓
2. Idempotency Check (cache lookup)
   ↓
3. Input Validation (Joi)
   ↓
4. Begin Database Transaction (SERIALIZABLE)
   ↓
5. Lock Accounts (deterministic order)
   ↓
6. Get Current Balances
   ↓
7. Validate Business Rules (sufficient balance)
   ↓
8. Create Transaction Record
   ↓
9. Create Ledger Entries (debit + credit)
   ↓
10. Update Balance Cache
   ↓
11. Record Idempotency Log
   ↓
12. Create Audit Log
   ↓
13. Commit Transaction
   ↓
14. Return Response
```

If any step fails, entire transaction rolls back.

## Scaling Strategy

### Horizontal Scaling

**Application Layer:**
- Stateless design allows infinite horizontal scaling
- Load balancer distributes traffic
- Each instance connects to shared database

```
        Load Balancer
       /      |      \
   App-1   App-2   App-3
       \      |      /
         Database
```

**Database Layer:**
- PostgreSQL connection pooling (50 connections per app instance)
- Read replicas for reporting queries
- Master-slave replication for high availability

### Vertical Scaling

**Database:**
- Start: db.t3.medium (2 vCPU, 4GB RAM)
- Growth: db.r6g.xlarge (4 vCPU, 32GB RAM)
- Scale: db.r6g.4xlarge (16 vCPU, 128GB RAM)

**Application:**
- Start: 0.5 vCPU, 1GB RAM per container
- Growth: 2 vCPU, 4GB RAM per container
- Auto-scale based on CPU/memory utilization

### Performance Optimizations

1. **Connection Pooling**: Reuse database connections (10-50 per instance)
2. **Prepared Statements**: PostgreSQL caches query plans
3. **Indexes**: All frequent queries have covering indexes
4. **Balance Cache**: O(1) balance lookups instead of O(n) aggregations
5. **Batch Operations**: Future enhancement for bulk transactions

## High Availability

### Database HA

```
Primary Database (Multi-AZ)
    ↓
Synchronous Replica (same region)
    ↓
Asynchronous Replica (different region)
```

- Automatic failover < 60 seconds
- Zero data loss with synchronous replication
- Point-in-time recovery from backups

### Application HA

```
Availability Zone 1:    App-1, App-2
Availability Zone 2:    App-3, App-4
```

- Health checks every 30 seconds
- Auto-replacement of unhealthy instances
- Graceful shutdown (finish in-flight requests)

## Security Architecture

### Network Security

```
Internet
    ↓
AWS WAF (DDoS protection)
    ↓
Application Load Balancer (SSL termination)
    ↓
Private Subnet (ECS Tasks)
    ↓
Private Subnet (RDS)
```

- No direct internet access to database
- All traffic encrypted (TLS 1.3)
- Security groups enforce least privilege

### Data Security

1. **Encryption at Rest**: AES-256 for database storage
2. **Encryption in Transit**: TLS 1.3 for all connections
3. **Secrets Management**: AWS Secrets Manager for credentials
4. **Audit Logging**: Complete transaction trail in database
5. **Rate Limiting**: Prevents abuse (100 req/min per IP)

### Application Security

1. **Input Validation**: Joi schema validation
2. **SQL Injection Prevention**: Parameterized queries only
3. **Helmet.js**: Secure HTTP headers
4. **Non-root Container**: Least privilege in Docker
5. **Dependency Scanning**: Regular npm audit

## Monitoring & Observability

### Metrics

**Application:**
- Request rate (requests/second)
- Error rate (%)
- Response time (p50, p95, p99)
- Active connections

**Database:**
- Connection pool utilization
- Query performance
- Deadlock frequency
- Replication lag

**Business:**
- Transaction volume
- Transaction success rate
- Balance changes
- Asset distribution

### Logging

**Structured Logs (JSON):**
```json
{
  "timestamp": "2024-02-15T10:30:00.000Z",
  "level": "info",
  "message": "Transaction completed",
  "transactionId": "...",
  "userId": "user_001",
  "amount": 100,
  "duration": 45
}
```

**Log Levels:**
- ERROR: Critical failures requiring immediate attention
- WARN: Retry attempts, degraded performance
- INFO: Important business events
- DEBUG: Detailed troubleshooting information

### Alerting

**Critical Alerts** (page on-call):
- Error rate > 1%
- Database unavailable
- Response time > 5 seconds

**Warning Alerts** (email team):
- Error rate > 0.1%
- Connection pool > 90% full
- Deadlock retries increasing

## Disaster Recovery

### Backup Strategy

1. **Automated Daily Backups**: Full database backup retained 30 days
2. **Point-in-Time Recovery**: Restore to any second within 35 days
3. **Geo-Replicated Backups**: Stored in multiple regions
4. **Backup Testing**: Monthly restore drills

### Recovery Procedures

**Minor Issues** (< 5 minutes data loss acceptable):
```
1. Identify failed primary database
2. Promote read replica to primary
3. Update DNS/endpoint
4. Monitor replication catch-up
```

**Major Issues** (zero data loss required):
```
1. Stop all application traffic
2. Restore from latest backup
3. Replay transaction logs
4. Verify data integrity
5. Resume traffic
```

### RPO/RTO Targets

- **RPO** (Recovery Point Objective): < 1 minute
- **RTO** (Recovery Time Objective): < 15 minutes
- **Data Loss**: Zero for committed transactions

## Cost Optimization

### Development Environment
- Single-AZ RDS (not Multi-AZ)
- Minimal compute resources
- Short backup retention
- **Cost: ~$75/month**

### Production Environment
- Multi-AZ RDS with replicas
- Auto-scaling compute
- Extended backup retention
- Enhanced monitoring
- **Cost: ~$900/month**

### Cost Reduction Strategies

1. **Reserved Instances**: 40% savings on predictable workloads
2. **Spot Instances**: 70% savings for non-critical tasks
3. **Storage Optimization**: Archive old audit logs to S3
4. **Right-sizing**: Monitor and adjust instance sizes
5. **Scheduled Scaling**: Reduce capacity during low-traffic hours

## Future Enhancements

### Phase 2: Advanced Features
- [ ] Multi-currency support
- [ ] Scheduled transactions
- [ ] Recurring payments
- [ ] Transaction reversal/refunds
- [ ] Batch transaction processing
- [ ] Webhook notifications

### Phase 3: Analytics
- [ ] Real-time balance analytics
- [ ] Fraud detection
- [ ] Spending patterns
- [ ] Predictive analytics
- [ ] Custom reporting

### Phase 4: Global Scale
- [ ] Multi-region deployment
- [ ] Active-active database
- [ ] Edge caching
- [ ] GraphQL API
- [ ] Microservices split

---

**Architecture designed for scale, reliability, and maintainability.**
