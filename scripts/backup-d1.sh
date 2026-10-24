#!/bin/sh
# Copia de seguridad de la base de datos D1 (producción) a backups/.
# Uso: sh ./scripts/backup-d1.sh
# Requiere las credenciales de Cloudflare de wrangler en el entorno.
set -e
mkdir -p backups
F="backups/inventarios-$(date +%Y%m%d-%H%M%S).sql"
npx wrangler d1 export inventarios --remote --output "$F"
echo "Backup guardado en $F"
echo "Para restaurar: npx wrangler d1 execute inventarios --remote --file=$F"
