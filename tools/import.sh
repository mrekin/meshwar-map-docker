#!/bin/bash
# MeshCore Wardrive Data Import Tool
# Interactive script for vetted manual imports with validation.
#
# Usage: Place a single .json export file in the imports/ directory, then run:
#   bash tools/import.sh          (host)
#   docker exec -it meshwar-map bash -c "cd /app/tools && bash import.sh"   (Docker)
#
# The script will:
#   1. Validate the JSON file
#   2. Prompt for contributor name, date, and region
#   3. Show an import summary for confirmation
#   4. Import into the SQLite database
#   5. Archive the file to data/processed/

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"   # .../tools  (or /app/tools in container)
ROOT_DIR="$(dirname "$SCRIPT_DIR")"            # repo root  (or /app)
IMPORTS_DIR="$ROOT_DIR/imports"                 # input files live here
DATA_DIR="$ROOT_DIR/data"

cd "$IMPORTS_DIR"

# 1. Check for JSON files
JSON_COUNT=$(ls -1 *.json 2>/dev/null | wc -l)
if [ "$JSON_COUNT" -eq 0 ]; then
    echo -e "\e[31m[ERROR] No .json files found in $IMPORTS_DIR.\e[0m"
    echo "  Place a wardrive export JSON file there and try again."
    exit 1
elif [ "$JSON_COUNT" -gt 1 ]; then
    echo -e "\e[33m[ERROR] Multiple .json files detected in $IMPORTS_DIR. Please keep only ONE.\e[0m"
    ls -1 *.json
    exit 1
fi

FILENAME=$(ls *.json)
echo -e "\e[34m[INFO] Found: $FILENAME\e[0m"

# 2. Prompts
while true; do
    read -p "Who was the Wardriver? (e.g., Chuck): " WARDRIVER
    [[ "$WARDRIVER" =~ ^[a-zA-Z0-9_-]+$ ]] && break
    echo -e "\e[31mInvalid name. Letters, numbers, hyphens, underscores only.\e[0m"
done

while true; do
    read -p "When did $WARDRIVER go Wardriving? (YYYY-MM-DD): " FILE_DATE
    if [[ "$FILE_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
        # Validate date is real and not in the future
        if date -d "$FILE_DATE" >/dev/null 2>&1; then
            INPUT_EPOCH=$(date -d "$FILE_DATE" +%s 2>/dev/null)
            NOW_EPOCH=$(date +%s)
            if [ "$INPUT_EPOCH" -le "$NOW_EPOCH" ]; then
                break
            fi
        fi
    fi
    echo -e "\e[31mInvalid date. Use YYYY-MM-DD format, not in the future.\e[0m"
done

read -p "Region code (e.g., WA, NSW, or press Enter to skip): " REGION
REGION=$(echo "$REGION" | tr '[:lower:]' '[:upper:]')

# 3. Pre-Validation (Dry Run)
echo -e "\n\e[34m[INFO] Validating data in $FILENAME...\e[0m"
PINGS=$(node "$SCRIPT_DIR/import.js" "$FILENAME" --dry-run 2>&1)

if [[ ! "$PINGS" =~ ^[0-9]+$ ]]; then
    echo -e "\e[31m[FAILED] Data Validation Error:\e[0m"
    echo "$PINGS"
    exit 1
fi

if [ "$PINGS" -eq 0 ]; then
    echo -e "\e[31m[FAILED] No valid ping samples found in file.\e[0m"
    exit 1
fi

# 4. Confirmation
echo -e "\n\e[33m╔════════════════════════════════════════╗"
echo -e "║           IMPORT SUMMARY               ║"
echo -e "╠════════════════════════════════════════╣"
echo -e "  FILE:        $FILENAME"
echo -e "  CONTRIBUTOR: $WARDRIVER"
echo -e "  DATE:        $FILE_DATE"
echo -e "  REGION:      ${REGION:-Not specified}"
echo -e "  VALID PINGS: $PINGS"
echo -e "╚════════════════════════════════════════╝\e[0m"

read -p "Does this look correct? (y/n): " CONFIRM
if [[ ! "$CONFIRM" =~ ^[yY]$ ]]; then
    echo -e "\e[31m[CANCELLED] Import aborted. No data was added.\e[0m"
    exit 0
fi

# 5. Import
echo -e "\e[34m[INFO] Importing data into database...\e[0m"

IMPORT_ARGS="$FILENAME --contributor $WARDRIVER"
if [ -n "$REGION" ]; then
    IMPORT_ARGS="$IMPORT_ARGS --region $REGION"
fi

node "$SCRIPT_DIR/import.js" $IMPORT_ARGS

if [ $? -ne 0 ]; then
    echo -e "\e[31m[FAILED] Import failed. Check errors above.\e[0m"
    exit 1
fi

# 6. Archive
mkdir -p "$DATA_DIR/processed"
NEW_NAME="${FILE_DATE}-${WARDRIVER}-${REGION:-UNKNOWN}-${PINGS}pings.json"
mv "$FILENAME" "$DATA_DIR/processed/$NEW_NAME"

echo -e "\n\e[32m══════════════════════════════════════════"
echo -e " [SUCCESS] Imported $PINGS pings from $WARDRIVER"
echo -e " [SUCCESS] Archived to data/processed/$NEW_NAME"
echo -e "══════════════════════════════════════════\e[0m"
