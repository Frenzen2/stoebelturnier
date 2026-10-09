#!/bin/sh
# Neue Versionsnummer setzen (in app.js, index.html, version.json), damit alle Geräte
# die neue Version automatisch laden. Aufruf: sh tools/version.sh
set -e
cd "$(dirname "$0")/.."
NEW=$(date +%Y-%m-%d-%H%M)
OLD=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' version.json)
sed -i "s/$OLD/$NEW/g" app.js index.html version.json
echo "Version $OLD -> $NEW"
