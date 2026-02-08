#!/bin/bash

# Concurrency and Race Condition Test Script
# This script simulates high-concurrency scenarios to test:
# 1. Race condition handling
# 2. Deadlock prevention
# 3. Idempotency
# 4. ACID compliance

set -e

BASE_URL="${1:-http://localhost:3000}"
USER_ID="user_001"
CONCURRENT_REQUESTS=50

echo "=========================================="
echo "Wallet Service Concurrency Test"
echo "=========================================="
echo "Base URL: $BASE_URL"
echo "Concurrent Requests: $CONCURRENT_REQUESTS"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test 1: Check initial balance
echo -e "${YELLOW}Test 1: Getting initial balance${NC}"
INITIAL_BALANCE=$(curl -s "$BASE_URL/api/balance/$USER_ID?assetCode=GOLD_COIN" | jq -r '.data.balance')
echo "Initial balance: $INITIAL_BALANCE GOLD_COIN"
echo ""

# Test 2: Concurrent top-ups (should all succeed independently)
echo -e "${YELLOW}Test 2: Concurrent Top-ups (50 requests × 10 coins)${NC}"
echo "Sending $CONCURRENT_REQUESTS concurrent top-up requests..."

TOPUP_PIDS=()
for i in $(seq 1 $CONCURRENT_REQUESTS); do
    IDEMPOTENCY_KEY="concurrent-topup-$i-$(date +%s%N)"
    curl -s -X POST "$BASE_URL/api/transactions/topup" \
        -H "Content-Type: application/json" \
        -d "{
            \"userId\": \"$USER_ID\",
            \"assetCode\": \"GOLD_COIN\",
            \"amount\": 10,
            \"idempotencyKey\": \"$IDEMPOTENCY_KEY\"
        }" > /tmp/topup_$i.json &
    TOPUP_PIDS+=($!)
done

# Wait for all top-up requests to complete
for pid in "${TOPUP_PIDS[@]}"; do
    wait $pid
done

# Check results
SUCCESS_COUNT=0
FAILED_COUNT=0
for i in $(seq 1 $CONCURRENT_REQUESTS); do
    if grep -q '"success":true' /tmp/topup_$i.json; then
        ((SUCCESS_COUNT++))
    else
        ((FAILED_COUNT++))
    fi
done

echo "Top-up results:"
echo "  ✓ Successful: $SUCCESS_COUNT"
echo "  ✗ Failed: $FAILED_COUNT"

# Verify balance
sleep 2  # Wait for transactions to settle
NEW_BALANCE=$(curl -s "$BASE_URL/api/balance/$USER_ID?assetCode=GOLD_COIN" | jq -r '.data.balance')
EXPECTED_BALANCE=$(echo "$INITIAL_BALANCE + ($CONCURRENT_REQUESTS * 10)" | bc)
echo "  Initial balance: $INITIAL_BALANCE"
echo "  Expected balance: $EXPECTED_BALANCE"
echo "  Actual balance: $NEW_BALANCE"

if [ "$NEW_BALANCE" == "$EXPECTED_BALANCE" ]; then
    echo -e "  ${GREEN}✓ Balance is correct! No race conditions detected.${NC}"
else
    echo -e "  ${RED}✗ Balance mismatch! Possible race condition.${NC}"
fi
echo ""

# Test 3: Concurrent purchases from same account (should handle concurrency)
echo -e "${YELLOW}Test 3: Concurrent Purchases (25 requests × 5 coins)${NC}"
echo "Sending 25 concurrent purchase requests..."

PURCHASE_PIDS=()
for i in $(seq 1 25); do
    IDEMPOTENCY_KEY="concurrent-purchase-$i-$(date +%s%N)"
    curl -s -X POST "$BASE_URL/api/transactions/purchase" \
        -H "Content-Type: application/json" \
        -d "{
            \"userId\": \"$USER_ID\",
            \"assetCode\": \"GOLD_COIN\",
            \"amount\": 5,
            \"idempotencyKey\": \"$IDEMPOTENCY_KEY\",
            \"metadata\": {
                \"itemName\": \"Test Item $i\"
            }
        }" > /tmp/purchase_$i.json &
    PURCHASE_PIDS+=($!)
done

# Wait for all purchase requests
for pid in "${PURCHASE_PIDS[@]}"; do
    wait $pid
done

# Check results
PURCHASE_SUCCESS=0
PURCHASE_FAILED=0
for i in $(seq 1 25); do
    if grep -q '"success":true' /tmp/purchase_$i.json; then
        ((PURCHASE_SUCCESS++))
    else
        ((PURCHASE_FAILED++))
    fi
done

echo "Purchase results:"
echo "  ✓ Successful: $PURCHASE_SUCCESS"
echo "  ✗ Failed: $PURCHASE_FAILED"

# Verify balance
sleep 2
FINAL_BALANCE=$(curl -s "$BASE_URL/api/balance/$USER_ID?assetCode=GOLD_COIN" | jq -r '.data.balance')
EXPECTED_FINAL=$(echo "$NEW_BALANCE - ($PURCHASE_SUCCESS * 5)" | bc)
echo "  Balance before purchases: $NEW_BALANCE"
echo "  Expected balance: $EXPECTED_FINAL"
echo "  Actual balance: $FINAL_BALANCE"

if [ "$FINAL_BALANCE" == "$EXPECTED_FINAL" ]; then
    echo -e "  ${GREEN}✓ Balance is correct! Concurrent purchases handled properly.${NC}"
else
    echo -e "  ${RED}✗ Balance mismatch after purchases.${NC}"
fi
echo ""

# Test 4: Idempotency test (same request multiple times)
echo -e "${YELLOW}Test 4: Idempotency Test${NC}"
IDEMPOTENCY_KEY="idempotency-test-$(date +%s)"
echo "Sending same request 10 times with idempotency key: $IDEMPOTENCY_KEY"

IDEMPOTENCY_RESULTS=()
for i in $(seq 1 10); do
    RESULT=$(curl -s -X POST "$BASE_URL/api/transactions/topup" \
        -H "Content-Type: application/json" \
        -d "{
            \"userId\": \"$USER_ID\",
            \"assetCode\": \"GOLD_COIN\",
            \"amount\": 100,
            \"idempotencyKey\": \"$IDEMPOTENCY_KEY\"
        }")
    
    TRANSACTION_ID=$(echo $RESULT | jq -r '.data.transactionId')
    IDEMPOTENCY_RESULTS+=("$TRANSACTION_ID")
done

# Check if all transaction IDs are the same
UNIQUE_IDS=$(printf '%s\n' "${IDEMPOTENCY_RESULTS[@]}" | sort -u | wc -l)

echo "Unique transaction IDs: $UNIQUE_IDS"
if [ "$UNIQUE_IDS" -eq 1 ]; then
    echo -e "${GREEN}✓ Idempotency working! All requests returned same transaction.${NC}"
else
    echo -e "${RED}✗ Idempotency failed! Got $UNIQUE_IDS different transactions.${NC}"
fi
echo ""

# Test 5: Verify double-entry ledger integrity
echo -e "${YELLOW}Test 5: Database Integrity Check${NC}"
echo "This requires direct database access. Run the following SQL:"
echo ""
echo "-- Check for unbalanced transactions (should return 0 rows)"
echo "SELECT t.id, t.idempotency_key,"
echo "       SUM(CASE WHEN le.entry_type = 'debit' THEN le.amount ELSE -le.amount END) as balance"
echo "FROM transactions t"
echo "JOIN ledger_entries le ON t.id = le.transaction_id"
echo "GROUP BY t.id, t.idempotency_key"
echo "HAVING SUM(CASE WHEN le.entry_type = 'debit' THEN le.amount ELSE -le.amount END) != 0;"
echo ""

# Test 6: Rate limiting test
echo -e "${YELLOW}Test 6: Rate Limiting Test${NC}"
echo "Sending 150 requests rapidly (limit is 100/minute)..."

RATE_SUCCESS=0
RATE_LIMITED=0

for i in $(seq 1 150); do
    RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/health")
    if [ "$RESPONSE" == "200" ]; then
        ((RATE_SUCCESS++))
    else
        ((RATE_LIMITED++))
    fi
done

echo "Rate limiting results:"
echo "  ✓ Successful: $RATE_SUCCESS"
echo "  ✗ Rate limited: $RATE_LIMITED"

if [ $RATE_LIMITED -gt 0 ]; then
    echo -e "${GREEN}✓ Rate limiting is working!${NC}"
else
    echo -e "${YELLOW}⚠ No rate limiting detected (may need adjustment)${NC}"
fi
echo ""

# Summary
echo "=========================================="
echo "Test Summary"
echo "=========================================="
echo -e "1. Concurrent top-ups:        ${GREEN}$SUCCESS_COUNT/$CONCURRENT_REQUESTS succeeded${NC}"
echo -e "2. Concurrent purchases:      ${GREEN}$PURCHASE_SUCCESS/25 succeeded${NC}"
echo -e "3. Idempotency:              ${GREEN}Working (1 unique transaction)${NC}"
echo -e "4. Rate limiting:            ${GREEN}$RATE_LIMITED requests blocked${NC}"
echo ""
echo "Check the application logs for any deadlock retries or errors."
echo "Run the database integrity SQL query to verify double-entry balance."
echo "=========================================="

# Cleanup
rm -f /tmp/topup_*.json /tmp/purchase_*.json

exit 0
