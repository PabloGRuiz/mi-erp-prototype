# ERP - Gestión Empresarial

Sistema ERP modular construido con estándares web nativos (HTML5 semántico, CSS Vanilla y ES Modules), arquitectura en capas, SQLite embebido (`node:sqlite`) y cero dependencias externas.

**Estado actual:** Etapa 4 — Módulo de **Ingesta Inteligente de Documentos por Lotes con Gemini API**, **Bandeja de Control Previa (Human-in-the-Loop)** y carga ACID en SQLite, sumado a Autenticación (`scrypt` + sesiones `HttpOnly`), RBAC, Inventario, Compras, Ventas y Kardex.

## Arquitectura del proyecto

- `index.html` y `styles.css`: Interfaz modular por pestañas (`Inventario`, `Compras`, `Ventas`, `Ingesta IA`, `Kardex`, `Usuarios`) y `<dialog>` nativo.
- `src/domain/`: Lógica de negocio pura compartida entre frontend y backend.
  - `money.js`: Aritmética monetaria en centavos enteros y formateo `Intl.NumberFormat`.
  - `product.js`: Validaciones de catálogo, estados de stock, KPIs, filtros y ordenamiento.
  - `movement.js`: Reglas de transición del Kardex (`IN`, `OUT`, `ADJUSTMENT`).
  - `auth.js`: Matriz RBAC (`ADMIN`, `OPERATOR`, `AUDITOR`) y validaciones de usuarios/credenciales.
  - `operations.js`: Reglas de proveedores, clientes, órdenes de compra multi-ítem y ventas con snapshot de precio y validación agregada de stock.
  - `intake.js`: Reconciliación determinista contra catálogo, detección de inconsistencias, validación de revisión humana y estadísticas de bandeja.
  - `csv.js`: Exportación CSV UTF-8 BOM protegida contra *CSV Formula Injection*.
- `src/repositories/`: Adaptadores del Patrón Repositorio asíncrono (`httpClient.js`, `httpAuthRepository.js`, `httpInventoryRepository.js`, `httpOperationsRepository.js`, `httpIntakeRepository.js`).
- `src/ui/`: Capas de vista XSS-safe (`createElement`, `textContent`, `DocumentFragment`, `replaceChildren`).
- `server/`: Backend local en Node.js puro:
  - `env.js`: Cargador de `.env` sin dependencias externas.
  - `db.js`: Conexión SQLite (`WAL`, `foreign_keys = ON`) y migraciones versionadas (`PRAGMA user_version = 3`) con soporte de `SAVEPOINT` para transacciones compuestas.
  - `ai/geminiExtractor.js`: Adaptador multimodal de Google Gemini (`x-goog-api-key` en servidor, `responseSchema` JSON, autodescubrimiento vía `ListModels` y rotación automática ante cuota/demanda/modelos retirados).
  - `auth.js` / `authStore.js`, `inventoryStore.js`, `operationsStore.js`, `intakeStore.js`: Persistencia transaccional ACID, detección de duplicados por SHA-256 y aprobación atómica de lotes.
  - `router.js` y `index.js`: API REST protegida por sesión y RBAC + servidor de estáticos por *allowlist*.
- `tests/`: Suite automatizada con `node:test` (`domain.test.js`, `api.test.js`, `etapa3.test.js`, `etapa4.test.js`).

## Configuración de Gemini API (Ingesta IA)

Copiá `.env.example` a `.env` dentro de `mi-erp/` y cargá tu clave de Google AI Studio:

```env
PORT=3000
GEMINI_API_KEY=tu_clave_de_gemini_aqui
GEMINI_MODEL=gemini-3.8-flash
GEMINI_AUTO_DISCOVER=true
```

*(El archivo `.env` está ignorado en `.gitignore` y la clave nunca se expone al navegador. El detector automático consulta `ListModels` sin consumir cuota de generación y rota automáticamente ante cuota agotada, picos de demanda o modelos retirados).*

## Endpoints de la API REST

- `GET /api/health`
- `GET /api/auth/status`, `POST /api/auth/setup`, `POST /api/auth/login`, `POST /api/auth/logout`
- `GET/POST /api/products`, `GET/PUT/DELETE /api/products/:id`, `GET/POST /api/movements`
- `GET/POST /api/suppliers`, `PUT /api/suppliers/:id`, `GET/POST /api/purchases`, `POST /api/purchases/:id/receive`, `POST /api/purchases/:id/cancel`
- `GET/POST /api/customers`, `PUT /api/customers/:id`, `GET/POST /api/sales`, `POST /api/sales/:id/cancel`
- `GET /api/ai/status`, `POST /api/ai/refresh`, `GET /api/intake`, `POST /api/intake/upload`, `GET/PUT /api/intake/:id`, `POST /api/intake/:id/approve`, `POST /api/intake/approve-batch`, `POST /api/intake/reject-errors`, `POST /api/intake/:id/reject`
- `GET/POST /api/users`, `PUT /api/users/:id` (solo `ADMIN`)

## Cómo ejecutarlo localmente

Requisitos: Node.js 24+ (incluye `node:sqlite` y `node:test` nativos, sin instalar dependencias).

```powershell
# Iniciar servidor HTTP + SQLite local en http://localhost:3000
npm run dev

# Ejecutar toda la suite de pruebas
npm test
```
