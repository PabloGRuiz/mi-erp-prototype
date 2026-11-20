import os
import random
from datetime import datetime, timedelta
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer

# --- CONFIGURACIÓN ---
CARPETA_SALIDA = "facturas_muestra"
CANTIDAD_FACTURAS = 15

# --- DATOS FICTICIOS ---
PROVEEDORES = [
    {
        "nombre": "TechCore Distribuciones S.A.",
        "cuit": "30-71458921-4",
        "direccion": "Av. Corrientes 1245, Piso 4, CABA",
        "iva": "IVA Responsable Inscripto",
        "email": "facturacion@techcore-demo.com.ar",
    },
    {
        "nombre": "NubeSur Infraestructura S.R.L.",
        "cuit": "30-70982341-9",
        "direccion": "Av. Santa Fe 3410, CABA",
        "iva": "IVA Responsable Inscripto",
        "email": "admin@nubesur-demo.com.ar",
    },
    {
        "nombre": "Redes & Seguridad del Plata S.A.",
        "cuit": "30-71620455-2",
        "direccion": "Paraná 580, Piso 2, CABA",
        "iva": "IVA Responsable Inscripto",
        "email": "ventas@redesplata-demo.com.ar",
    },
    {
        "nombre": "Martín Alejandro Gómez (Servicios IT)",
        "cuit": "20-32456789-3",
        "direccion": "Calle 48 N° 712, La Plata, Buenos Aires",
        "iva": "Responsable Monotributo",
        "email": "mgomez.it@demo.com",
    },
    {
        "nombre": "Silicon Andes Mayorista S.A.",
        "cuit": "30-71109283-7",
        "direccion": "Av. del Libertador 6120, CABA",
        "iva": "IVA Responsable Inscripto",
        "email": "cobranzas@siliconandes-demo.com.ar",
    },
]

CLIENTE_RECEPTOR = {
    "nombre": "Empresa Demo Tecnología S.A.",
    "cuit": "30-71999888-1",
    "direccion": "Av. de Mayo 850, Monserrat, CABA",
    "iva": "IVA Responsable Inscripto",
}

CATALOGO_IT = [
    ("SRV-DL380", "Servidor Rack 2U Intel Xeon Silver 4314 32GB RAM", 3200000, 4500000),
    ("NB-TP14", "Notebook Corporativa 14\" Intel Core i7 16GB 512GB NVMe", 1100000, 1650000),
    ("NB-PRO15", "Notebook Workstation 15.6\" Ryzen 7 32GB 1TB SSD", 1450000, 2100000),
    ("SW-24P", "Switch Administrable L2 24 Puertos Gigabit PoE+", 380000, 620000),
    ("FW-NG60", "Firewall Next-Gen UTM con Licencia 1 Año", 850000, 1400000),
    ("AP-WIFI6", "Access Point Empresarial Wi-Fi 6 Dual Band", 145000, 240000),
    ("MON-27QHD", "Monitor IPS 27\" QHD 2560x1440 USB-C", 320000, 490000),
    ("SSD-NVME2", "Disco Sólido SSD NVMe M.2 2TB PCIe Gen4", 160000, 250000),
    ("HDD-NAS8", "Disco Rígido Enterprise SATA 8TB 7200RPM", 240000, 360000),
    ("RAM-32ECC", "Memoria RAM 32GB DDR4 ECC Registered para Servidor", 180000, 290000),
    ("UPS-1500", "UPS Interactiva 1500VA / 900W Rackeable", 290000, 450000),
    ("LIC-M365", "Licencia Suite Ofimática Cloud Business Standard (Anual)", 140000, 195000),
    ("LIC-EDR", "Licencia Endpoint Detection & Response (EDR) por Equipo", 45000, 75000),
    ("CAB-CAT6A", "Bobina Cable UTP Cat6A Blindado 305m", 190000, 280000),
    ("RACK-42U", "Gabinete Rack Mural/Pie 42U con Puerta Perforada", 750000, 1150000),
    ("SOP-HR", "Pack 10 Horas Soporte Técnico Infraestructura / Redes", 350000, 550000),
    ("DOC-USBC", "Docking Station USB-C Triple Monitor 100W PD", 120000, 190000),
]


def formato_moneda(valor: float) -> str:
    return f"$ {valor:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def generar_factura_pdf(indice: int, ruta_archivo: str):
    proveedor = random.choice(PROVEEDORES)
    es_monotributo = "Monotributo" in proveedor["iva"]
    tipo_factura = "C" if es_monotributo else "A"

    punto_venta = random.randint(1, 12)
    nro_comprobante = random.randint(100, 99999)
    nro_formateado = f"{punto_venta:04d}-{nro_comprobante:08d}"

    fecha_emision = datetime.now() - timedelta(days=random.randint(0, 120))
    fecha_vencimiento = fecha_emision + timedelta(days=random.choice([15, 30, 45]))
    cae_ficticio = "".join([str(random.randint(0, 9)) for _ in range(14)])

    doc = SimpleDocTemplate(
        ruta_archivo,
        pagesize=A4,
        rightMargin=15 * mm,
        leftMargin=15 * mm,
        topMargin=15 * mm,
        bottomMargin=15 * mm,
    )

    styles = getSampleStyleSheet()
    estilo_titulo = ParagraphStyle("Titulo", parent=styles["Heading1"], fontSize=14, spaceAfter=4)
    estilo_normal = ParagraphStyle("NormalChico", parent=styles["Normal"], fontSize=9, leading=12)
    estilo_bold = ParagraphStyle("BoldChico", parent=styles["Normal"], fontSize=9, leading=12, fontName="Helvetica-Bold")
    estilo_demo = ParagraphStyle(
        "Demo",
        parent=styles["Normal"],
        fontSize=8,
        textColor=colors.red,
        alignment=1,
        fontName="Helvetica-Bold",
    )

    elementos = []

    # Banner de advertencia
    elementos.append(Paragraph("DOCUMENTO NO VÁLIDO COMO FACTURA - DATOS FICTICIOS PARA DEMOSTRACIÓN", estilo_demo))
    elementos.append(Spacer(1, 6 * mm))

    # Encabezado (Proveedor | Tipo | Datos Comprobante)
    datos_prov = Paragraph(
        f"<b>{proveedor['nombre']}</b><br/>"
        f"CUIT/CUIL: {proveedor['cuit']}<br/>"
        f"{proveedor['direccion']}<br/>"
        f"{proveedor['iva']}<br/>"
        f"{proveedor['email']}",
        estilo_normal,
    )

    letra_box = Paragraph(
        f"<font size='22'><b>{tipo_factura}</b></font><br/><font size='7'>COD. {'11' if tipo_factura == 'C' else '01'}</font>",
        ParagraphStyle("Letra", alignment=1, leading=18),
    )

    datos_comp = Paragraph(
        f"<b>FACTURA {tipo_factura}</b><br/>"
        f"<b>N°:</b> {nro_formateado}<br/>"
        f"<b>Fecha Emisión:</b> {fecha_emision.strftime('%d/%m/%Y')}<br/>"
        f"<b>Vencimiento:</b> {fecha_vencimiento.strftime('%d/%m/%Y')}<br/>"
        f"<b>Condición de Venta:</b> Cuenta Corriente",
        estilo_normal,
    )

    tabla_header = Table([[datos_prov, letra_box, datos_comp]], colWidths=[80 * mm, 20 * mm, 80 * mm])
    tabla_header.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.75, colors.grey),
                ("BOX", (1, 0), (1, 0), 1, colors.black),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("BACKGROUND", (1, 0), (1, 0), colors.whitesmoke),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    elementos.append(tabla_header)
    elementos.append(Spacer(1, 5 * mm))

    # Datos del Cliente
    datos_cliente = Paragraph(
        f"<b>Señor(es):</b> {CLIENTE_RECEPTOR['nombre']} &nbsp;&nbsp;&nbsp; "
        f"<b>CUIT:</b> {CLIENTE_RECEPTOR['cuit']}<br/>"
        f"<b>Domicilio:</b> {CLIENTE_RECEPTOR['direccion']} &nbsp;&nbsp;&nbsp; "
        f"<b>Condición IVA:</b> {CLIENTE_RECEPTOR['iva']}",
        estilo_normal,
    )
    tabla_cliente = Table([[datos_cliente]], colWidths=[180 * mm])
    tabla_cliente.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.5, colors.grey),
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F7F9FC")),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    elementos.append(tabla_cliente)
    elementos.append(Spacer(1, 6 * mm))

    # Selección aleatoria de ítems IT
    cantidad_items = random.randint(2, 7)
    items_seleccionados = random.sample(CATALOGO_IT, cantidad_items)

    filas_items = [["Código", "Descripción", "Cant.", "Precio Unit.", "Subtotal"]]
    subtotal_acumulado = 0.0

    for codigo, desc, p_min, p_max in items_seleccionados:
        cantidad = random.randint(1, 10)
        precio_unit = round(random.uniform(p_min, p_max), 2)
        subtotal_linea = round(cantidad * precio_unit, 2)
        subtotal_acumulado += subtotal_linea

        filas_items.append(
            [
                codigo,
                Paragraph(desc, estilo_normal),
                str(cantidad),
                formato_moneda(precio_unit),
                formato_moneda(subtotal_linea),
            ]
        )

    tabla_items = Table(filas_items, colWidths=[24 * mm, 82 * mm, 14 * mm, 30 * mm, 30 * mm])
    tabla_items.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F2937")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 8.5),
                ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
                ("ALIGN", (0, 0), (0, -1), "CENTER"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("GRID", (0, 0), (-1, -1), 0.25, colors.lightgrey),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F9FAFB")]),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    elementos.append(tabla_items)
    elementos.append(Spacer(1, 6 * mm))

    # Totales
    if es_monotributo:
        iva_monto = 0.0
        total_final = subtotal_acumulado
        filas_totales = [
            ["Subtotal:", formato_moneda(subtotal_acumulado)],
            ["IVA (No discriminado):", formato_moneda(iva_monto)],
            ["TOTAL:", formato_moneda(total_final)],
        ]
    else:
        iva_monto = round(subtotal_acumulado * 0.21, 2)
        total_final = round(subtotal_acumulado + iva_monto, 2)
        filas_totales = [
            ["Subtotal Neto Gravado:", formato_moneda(subtotal_acumulado)],
            ["IVA 21%:", formato_moneda(iva_monto)],
            ["TOTAL:", formato_moneda(total_final)],
        ]

    tabla_totales = Table(filas_totales, colWidths=[145 * mm, 35 * mm])
    tabla_totales.setStyle(
        TableStyle(
            [
                ("ALIGN", (0, 0), (-1, -1), "RIGHT"),
                ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -2), 9),
                ("FONTSIZE", (0, -1), (-1, -1), 11),
                ("LINEABOVE", (0, -1), (-1, -1), 1, colors.black),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    elementos.append(tabla_totales)
    elementos.append(Spacer(1, 10 * mm))

    # Pie con CAE ficticio
    elementos.append(
        Paragraph(
            f"<b>CAE N° (Ficticio):</b> {cae_ficticio} &nbsp;&nbsp;|&nbsp;&nbsp; "
            f"<b>Fecha Vto. CAE:</b> {(fecha_emision + timedelta(days=10)).strftime('%d/%m/%Y')}",
            estilo_normal,
        )
    )

    doc.build(elementos)


def main():
    os.makedirs(CARPETA_SALIDA, exist_ok=True)
    for i in range(1, CANTIDAD_FACTURAS + 1):
        nombre_archivo = f"factura_it_muestra_{i:03d}.pdf"
        ruta = os.path.join(CARPETA_SALIDA, nombre_archivo)
        generar_factura_pdf(i, ruta)
    print(f"Listo: se generaron {CANTIDAD_FACTURAS} facturas en '{CARPETA_SALIDA}/'")


if __name__ == "__main__":
    main()