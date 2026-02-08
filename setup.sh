#!/bin/bash

# Dino Ventures Wallet Service - Quick Setup Script
# This script sets up the entire wallet service with one command

set -e

echo "=========================================="
echo "Dino Ventures Wallet Service Setup"
echo "=========================================="
echo ""

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    echo "Visit: https://docs.docker.com/get-docker/"
    exit 1
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose is not installed. Please install Docker Compose first."
    echo "Visit: https://docs.docker.com/compose/install/"
    exit 1
fi

echo "✓ Docker and Docker Compose are installed"
echo ""

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    echo "📝 Creating .env file from template..."
    cp .env.example .env
    echo "✓ .env file created"
    echo ""
else
    echo "✓ .env file already exists"
    echo ""
fi

# Stop any existing containers
echo "🛑 Stopping any existing containers..."
docker-compose down -v 2>/dev/null || true
echo ""

# Build and start services
echo "🏗️  Building Docker images..."
docker-compose build --no-cache
echo ""

echo "🚀 Starting services..."
docker-compose up -d
echo ""

# Wait for PostgreSQL to be ready
echo "⏳ Waiting for PostgreSQL to be ready..."
for i in {1..30}; do
    if docker-compose exec -T postgres pg_isready -U wallet_admin -d wallet_service > /dev/null 2>&1; then
        echo "✓ PostgreSQL is ready!"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "❌ PostgreSQL failed to start within 30 seconds"
        docker-compose logs postgres
        exit 1
    fi
    echo "  Attempt $i/30..."
    sleep 2
done
echo ""

# Wait for application to be ready
echo "⏳ Waiting for wallet service to be ready..."
for i in {1..30}; do
    if curl -s http://localhost:3000/health > /dev/null 2>&1; then
        echo "✓ Wallet service is ready!"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "❌ Wallet service failed to start within 30 seconds"
        docker-compose logs wallet-service
        exit 1
    fi
    echo "  Attempt $i/30..."
    sleep 2
done
echo ""

# Display service information
echo "=========================================="
echo "✨ Setup Complete!"
echo "=========================================="
echo ""
echo "📊 Service Information:"
echo "  • Application: http://localhost:3000"
echo "  • Health Check: http://localhost:3000/health"
echo "  • Database: localhost:5432"
echo "  • PgAdmin (dev): http://localhost:5050 (start with: docker-compose --profile dev up -d)"
echo ""
echo "🧪 Quick Test:"
echo "  curl http://localhost:3000/health"
echo ""
echo "📖 Documentation:"
echo "  • API Docs: README.md"
echo "  • Deployment: DEPLOYMENT.md"
echo "  • Run tests: ./test-concurrency.sh"
echo ""
echo "🔍 Useful Commands:"
echo "  • View logs:        docker-compose logs -f"
echo "  • Stop services:    docker-compose down"
echo "  • Restart services: docker-compose restart"
echo "  • Reset database:   docker-compose down -v && docker-compose up -d"
echo ""

# Run a quick health check
echo "🏥 Running health check..."
HEALTH_RESPONSE=$(curl -s http://localhost:3000/health)
echo "$HEALTH_RESPONSE" | jq . 2>/dev/null || echo "$HEALTH_RESPONSE"
echo ""

# Show initial user balances
echo "💰 Initial User Balances:"
curl -s http://localhost:3000/api/balance/user_001 | jq '.data.balances' 2>/dev/null || echo "Could not fetch balances"
echo ""

echo "=========================================="
echo "Ready to accept requests! 🎉"
echo "=========================================="

exit 0
