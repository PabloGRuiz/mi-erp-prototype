# ERP - Gestión de Inventario

Sistema ERP modular construido paso a paso con estándares web nativos (HTML5 semántico, CSS Vanilla y ES Modules), arquitectura en capas, SQLite embebido y cero dependencias externas.

**Estado actual:** Etapa 2 — Módulo de Inventario persistido en SQLite local (`node:sqlite`) con transacciones ACID, **Kardex inmutable** de movimientos de stock y exportación CSV segura.

## Arquitectura del proyecto

- `index.html` y `styles.css`: Estructura semántica HTML5, KPIs, formulario de productos, filtros, sección de Kardex y modal nativo `<dialog>` en CSS Vanilla puro.
- `src/domain/`: Lógica de negocio pura compartida entre frontend y backend (sin dependencias del DOM).
  - `money.js`: Aritmética monetaria en centavos enteros y formateo con `Intl.NumberFormat`.
  - `product.js`: Validaciones (SKU único, montos, enteros), estados de stock, métricas KPI, filtros y ordenamiento inmutable.
  - `movement.js`: Reglas de validación y transiciones de stock (`IN`, `OUT`, `ADJUSTMENT`) para el Kardex.
  - `csv.js`: Generación de CSV UTF-8 BOM con protección contra *CSV Formula Injection*.
- `src/repositories/`: Adaptadores del Patrón Repositorio asíncrono.
  - `httpInventoryRepository.js`: Adaptador activo contra la API REST (`/api/products` y `/api/movements`).
  - `localStorageProductRepository.js`: Adaptador local de la Etapa 1 conservado para referencia y pruebas.
- `src/ui/`: Renderizado seguro del DOM (cero `innerHTML`, prevención de XSS vía `createElement`, `textContent`, `DocumentFragment` y `replaceChildren`).
  - `inventoryView.js`: Vista de inventario, KPIs y `<dialog>` de confirmación.
  - `kardexView.js`: Vista del libro Kardex, formulario de movimientos y descarga CSV.
- `src/main.js`: Punto de composición, estado y *Event Delegation*.
- `server/`: Backend local en Node.js puro (cero dependencias).
  - `db.js`: Conexión SQLite (`WAL`, `foreign_keys = ON`), esquema relacional y helper transaccional ACID.
  - `inventoryStore.js`: Operaciones transaccionales de catálogo y Kardex.
  - `router.js`: API REST JSON y servidor de estáticos por *allowlist* segura.
  - `index.js`: Arranque HTTP + SQLite (`data/erp.db`) con apagado limpio.
- `tests/`: Suite automatizada con `node:test` (`domain.test.js` y `api.test.js`).

## Endpoints de la API REST

- `GET /api/health`
- `GET /api/products`, `GET /api/products/:id`, `POST /api/products`, `PUT /api/products/:id`, `DELETE /api/products/:id`
- `GET /api/movements?productId=&type=&limit=`, `POST /api/movements`

## Cómo ejecutarlo localmente

Requisitos: Node.js 24+ (incluye `node:sqlite` y `node:test` nativos, sin instalar paquetes).

```powershell
# Iniciar servidor HTTP + SQLite local en http://localhost:3000
npm run dev

# Ejecutar pruebas unitarias y de integración API/SQLite
npm test
```

## Próximos pasos planificados

1. **Etapa 3:** Módulos conectados (Compras a proveedores / Ventas y facturación), autenticación y roles (RBAC).
2. **Etapa 4:** Capa de IA aplicada detrás de proxy backend seguro (copiloto analítico sobre el Kardex y sugerencias de reposición).
