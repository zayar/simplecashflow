#!/bin/bash

# Test Cloud SQL Proxy connectivity
echo "Testing Cloud SQL Proxy setup..."

# Check if we have required environment variables
if [[ -z "${DB_PASS:-}" ]]; then
  echo "Please set DB_PASS environment variable"
  echo "export DB_PASS='your_password_here'"
  exit 1
fi

# Configuration
PROJECT_ID="aiaccount-1c845"
REGION="asia-southeast1"
INSTANCE_CONN="aiaccount-1c845:asia-southeast1:cashflow-mysql"
DB_NAME="cashflow_prod"
DB_USER="root"

# Start Cloud SQL Proxy
echo "Starting Cloud SQL Proxy..."
./cloud-sql-proxy --address 0.0.0.0 --port 3307 "$INSTANCE_CONN" > /dev/null 2>&1 &
PROXY_PID=$!

# Wait for proxy to start
sleep 3

# Test database connection
echo "Testing database connection..."
export DATABASE_URL="mysql://${DB_USER}:${DB_PASS}@localhost:3307/${DB_NAME}"

# Try to connect using mysql2 (if available) or just check if port is open
if command -v mysql >/dev/null 2>&1; then
  echo "Testing with mysql client..."
  mysql --version
  if mysql -h localhost -P 3307 -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "SELECT 1 as test;" 2>/dev/null; then
    echo "✅ Database connection successful!"
  else
    echo "❌ Database connection failed"
  fi
else
  echo "MySQL client not available, testing port connectivity..."
  if nc -z localhost 3307 2>/dev/null; then
    echo "✅ Port 3307 is open (proxy running)"
  else
    echo "❌ Port 3307 is not accessible"
  fi
fi

# Test with Node.js if available
if command -v node >/dev/null 2>&1; then
  echo "Testing with Node.js..."
  node -e "
    const mysql = require('mysql2/promise');
    async function test() {
      try {
        const connection = await mysql.createConnection(process.env.DATABASE_URL);
        const [rows] = await connection.execute('SELECT 1 as test');
        console.log('✅ Node.js database connection successful:', rows);
        await connection.end();
      } catch (err) {
        console.log('❌ Node.js database connection failed:', err.message);
      }
    }
    test();
  "
fi

# Kill proxy
kill $PROXY_PID 2>/dev/null
echo "Cloud SQL Proxy stopped."
