#!/bin/bash
# Usage: ./scripts/backup.sh
# Dumps the database to backups/zentrade_YYYY-MM-DD.sql
# Reads DATABASE_URL from server/.env automatically

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found"
  exit 1
fi

DATABASE_URL=$(grep '^DATABASE_URL=' "$ENV_FILE" | cut -d '=' -f2-)

if [ -z "$DATABASE_URL" ]; then
  echo "Error: DATABASE_URL not set in .env"
  exit 1
fi

BACKUP_DIR="$SCRIPT_DIR/../backups"
mkdir -p "$BACKUP_DIR"

FILENAME="zentrade_$(date +%Y-%m-%d_%H%M%S).sql"
OUTPUT="$BACKUP_DIR/$FILENAME"

echo "Backing up to $OUTPUT ..."
pg_dump "$DATABASE_URL" --no-owner --no-acl -f "$OUTPUT"
echo "Done. $(du -sh "$OUTPUT" | cut -f1) written."
