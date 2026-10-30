#!/usr/bin/env bash
# Sirve el sitio por HTTP (útil en local para admin ↔ flujo en vivo).
# En GitHub Pages NO hace falta este script: abre la URL de Pages
# (Settings → Pages → /docs). Ver LEEME.txt sección A.
PORT="${1:-8765}"
cd "$(dirname "$0")"
echo ""
echo "  Local (mismo navegador):"
echo "    http://127.0.0.1:${PORT}/index.html"
echo "    http://127.0.0.1:${PORT}/solicitar.html"
echo "    http://127.0.0.1:${PORT}/admin.html   (admin / admin123)"
echo ""
echo "  GitHub Pages: no uses este script — abre la URL pública del repo."
echo "  No uses file:// (doble clic en el HTML) — rompe imágenes/admin."
echo "  Ctrl+C para detener."
echo ""
exec python3 -m http.server "$PORT"
