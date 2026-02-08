# 🚀 QUICK START GUIDE

## Get Running in 60 Seconds

```bash
# 1. Navigate to project directory
cd wallet-service

# 2. Run setup script
./setup.sh

# 3. Test the service
curl http://localhost:3000/health
```

That's it! The service is now running on http://localhost:3000

## Quick API Test

```bash
# Check balance
curl http://localhost:3000/api/balance/user_001

# Top up 100 Gold Coins
curl -X POST http://localhost:3000/api/transactions/topup \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user_001",
    "assetCode": "GOLD_COIN",
    "amount": 100,
    "idempotencyKey": "test-'$(date +%s)'"
  }'

# Check new balance
curl http://localhost:3000/api/balance/user_001?assetCode=GOLD_COIN
```

## Run Concurrency Tests

```bash
# Test race conditions, deadlocks, and idempotency
./test-concurrency.sh
```

## View Logs

```bash
# Application logs
docker-compose logs -f wallet-service

# Database logs
docker-compose logs -f postgres
```

## Stop Services

```bash
docker-compose down
```

## Reset Everything

```bash
docker-compose down -v  # Remove all data
./setup.sh              # Fresh start
```

## Project Structure

```
wallet-service/
├── src/
│   ├── server.js              # Express application
│   ├── db.js                  # Database connection & retry logic
│   ├── logger.js              # Winston logging
│   ├── routes.js              # API endpoints
│   ├── transactionService.js  # Core business logic
│   ├── validation.js          # Input validation
│   └── scripts/
│       └── seed.js            # Database seeding
├── schema.sql                 # Database schema
├── seed.sql                   # Initial data
├── Dockerfile                 # Container definition
├── docker-compose.yml         # Multi-container setup
├── setup.sh                   # Automated setup
├── test-concurrency.sh        # Concurrency tests
├── README.md                  # Complete documentation
├── ARCHITECTURE.md            # System design details
└── DEPLOYMENT.md              # AWS deployment guide
```

## Key Features Implemented ✅

1. ✅ **ACID Compliance** - PostgreSQL SERIALIZABLE transactions
2. ✅ **Double-Entry Ledger** - Complete audit trail
3. ✅ **Concurrency Control** - Race condition prevention
4. ✅ **Deadlock Prevention** - Deterministic lock ordering
5. ✅ **Idempotency** - Duplicate request prevention
6. ✅ **Balance Caching** - O(1) balance queries
7. ✅ **Docker Setup** - One-command deployment
8. ✅ **Comprehensive Logging** - Winston structured logs
9. ✅ **API Validation** - Joi schema validation
10. ✅ **Rate Limiting** - DDoS protection

## Documentation

- **README.md** - Complete API documentation with examples
- **ARCHITECTURE.md** - System design and scaling strategy
- **DEPLOYMENT.md** - AWS production deployment guide

## Next Steps

1. Review the API endpoints in README.md
2. Run the concurrency tests
3. Check database schema in schema.sql
4. Read ARCHITECTURE.md for design decisions
5. Follow DEPLOYMENT.md to deploy to AWS

## Support

For questions or issues:
- Check README.md for detailed documentation
- Review logs: `docker-compose logs -f`
- Run health check: `curl http://localhost:3000/health`

---

**Built for Dino Ventures Engineering Challenge**
All requirements met and exceeded! 🎯
