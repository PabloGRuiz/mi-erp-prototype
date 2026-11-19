# ERP - Gestión de Inventario

Sistema ERP modular construido paso a paso con estándares web nativos (HTML5 semántico, CSS Vanilla y ES Modules), arquitectura en capas y cero dependencias externas.

**Estado actual:** Etapa 1 — Módulo de Inventario con persistencia en `localStorage` bajo Patrón Repositorio asíncrono.

## Arquitectura del proyecto

- `index.html`: Estructura semántica HTML5, panel de KPIs, formulario de alta/edición, barra de búsqueda/filtros y modal nativo `<dialog>`.
- `styles.css`: Estilos en CSS Vanilla puro sin frameworks ni CDNs.
- `src/domain/`: Lógica de negocio pura sin dependencias del DOM.
  - `money.js`: Aritmética monetaria en centavos enteros y formateo con `Intl.NumberFormat`.
  - `product.js`: Validaciones (SKU único, montos, enteros), estados de stock, agregaciones KPI, filtros y ordenamiento inmutable.
- `src/repositories/`: Adaptadores de persistencia desacoplados.
  - `localStorageProductRepository.js`: Repositorio asíncrono sobre `localStorage` con versionado de esquema y recuperación segura.
- `src/ui/`: Renderizado seguro del DOM (prevención de XSS mediante `createElement`, `textContent`, `DocumentFragment` y `replaceChildren`).
  - `inventoryView.js`: Vista del inventario, KPIs y manejo del `<dialog>` de confirmación.
- `src/main.js`: Punto de composición, manejo de estado y *Event Delegation*.
- `tests/domain.test.js`: Suite de pruebas unitarias con `node:test`.
- `dev-server.mjs`: Servidor HTTP estático local en Node.js puro con bloqueo de *path traversal*.

## Cómo ejecutarlo localmente

Requisitos: Node.js 24+ (o cualquier servidor HTTP estático para servir ES Modules).

```powershell
# Levantar servidor local en http://localhost:3000
npm run dev

# Ejecutar pruebas unitarias
npm test
```

## Próximos pasos planificados

1. **Etapa 2 + SQLite local:** API REST en Node.js + SQLite (tabla de productos + Kardex inmutable de movimientos de stock) reemplazando únicamente el adaptador en `src/repositories/`.
2. **Etapa 3:** Autenticación, roles (RBAC) y módulos conectados (Compras / Ventas).
3. **Etapa 4:** Capa de IA aplicada detrás de proxy backend seguro (copiloto analítico y sugerencias de reposición).
