#!/usr/bin/env python3
"""
HR PDF Report Generator — Emeros EMS
Called by server.js via: python3 generate_report.py <type> <output_path> [params...]
"""

import sys, json, sqlite3, os, datetime, calendar
from reportlab.lib.pagesizes import letter, landscape
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (SimpleDocTemplate, Table, TableStyle, Paragraph,
                                 Spacer, HRFlowable, KeepTogether)
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT

DB_PATH = os.path.join(os.path.dirname(__file__), 'data', 'ems.db')

# ── Colors ───────────────────────────────────────────────────
GREEN_DARK  = colors.HexColor('#1e4d3b')
GREEN_MED   = colors.HexColor('#2d6e55')
GREEN_LIGHT = colors.HexColor('#e8f0ec')
GRAY_LIGHT  = colors.HexColor('#f7f5f2')
GRAY_MED    = colors.HexColor('#d4cfc9')
BLACK       = colors.black
WHITE       = colors.white

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def fmt_date(d):
    if not d:
        return ''
    try:
        dt = datetime.datetime.strptime(str(d)[:10], '%Y-%m-%d')
        return dt.strftime('%m/%d/%Y')
    except:
        return str(d) if d else ''

def fmt_phone(p):
    if not p:
        return ''
    digits = ''.join(c for c in str(p) if c.isdigit())
    if len(digits) == 10:
        return f"({digits[:3]}) {digits[3:6]}-{digits[6:]}"
    return str(p)

# ── Shared header / footer ─────────────────────────────────
ORG_NAME    = "NY COMMUNITY WELLNESS CENTER CORP"
ORG_SUBTITLE = "Human Resources Department"

def build_header_footer(canvas, doc, title, subtitle=''):
    canvas.saveState()
    w, h = doc.pagesize

    # Header bar
    canvas.setFillColor(GREEN_DARK)
    canvas.rect(0, h - 1.1*inch, w, 1.1*inch, fill=1, stroke=0)

    # Org name
    canvas.setFillColor(WHITE)
    canvas.setFont('Helvetica-Bold', 13)
    canvas.drawString(0.5*inch, h - 0.42*inch, ORG_NAME)

    canvas.setFont('Helvetica', 9)
    canvas.drawString(0.5*inch, h - 0.62*inch, ORG_SUBTITLE)

    # Report title (right side)
    canvas.setFont('Helvetica-Bold', 11)
    canvas.drawRightString(w - 0.5*inch, h - 0.42*inch, title)
    if subtitle:
        canvas.setFont('Helvetica', 9)
        canvas.drawRightString(w - 0.5*inch, h - 0.62*inch, subtitle)

    # Green accent line under header
    canvas.setFillColor(GREEN_MED)
    canvas.rect(0, h - 1.15*inch, w, 0.05*inch, fill=1, stroke=0)

    # Footer
    canvas.setFillColor(GRAY_MED)
    canvas.rect(0, 0.35*inch, w, 0.01*inch, fill=1, stroke=0)

    canvas.setFillColor(colors.HexColor('#6b6560'))
    canvas.setFont('Helvetica', 7.5)
    today = datetime.datetime.now().strftime('%B %d, %Y')
    canvas.drawString(0.5*inch, 0.18*inch, f"Generated: {today}  |  {ORG_NAME}  |  CONFIDENTIAL")
    canvas.drawRightString(w - 0.5*inch, 0.18*inch, f"Page {doc.page}")

    # Signature block (Medical Director) — bottom right of each page
    sig_x = w - 3.2*inch
    sig_y = 0.55*inch
    canvas.setStrokeColor(GREEN_DARK)
    canvas.setLineWidth(0.5)
    canvas.line(sig_x, sig_y, sig_x + 2.5*inch, sig_y)
    canvas.setFillColor(GREEN_DARK)
    canvas.setFont('Helvetica-Bold', 7)
    canvas.drawString(sig_x, sig_y - 0.13*inch, 'Medical Director Signature')
    canvas.setFont('Helvetica', 6.5)
    canvas.drawString(sig_x, sig_y - 0.24*inch, 'Date: ________________')

    canvas.restoreState()

def make_table_style(header_bg=GREEN_DARK, alt_bg=GRAY_LIGHT):
    return TableStyle([
        # Header
        ('BACKGROUND', (0,0), (-1,0), header_bg),
        ('TEXTCOLOR',  (0,0), (-1,0), WHITE),
        ('FONTNAME',   (0,0), (-1,0), 'Helvetica-Bold'),
        ('FONTSIZE',   (0,0), (-1,0), 8),
        ('ALIGN',      (0,0), (-1,0), 'CENTER'),
        ('VALIGN',     (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING', (0,0), (-1,0), 5),
        ('BOTTOMPADDING', (0,0), (-1,0), 5),
        # Data rows
        ('FONTNAME',   (0,1), (-1,-1), 'Helvetica'),
        ('FONTSIZE',   (0,1), (-1,-1), 8),
        ('TOPPADDING', (0,1), (-1,-1), 4),
        ('BOTTOMPADDING', (0,1), (-1,-1), 4),
        ('LEFTPADDING',  (0,0), (-1,-1), 5),
        ('RIGHTPADDING', (0,0), (-1,-1), 5),
        # Alternating rows
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [WHITE, alt_bg]),
        # Grid
        ('GRID',       (0,0), (-1,-1), 0.3, GRAY_MED),
        ('LINEBELOW',  (0,0), (-1,0), 1.0, GREEN_MED),
        ('BOX',        (0,0), (-1,-1), 0.5, GREEN_DARK),
    ])

# ═══════════════════════════════════════════════════════════
# REPORT 1: MONTHLY ROSTER
# ═══════════════════════════════════════════════════════════
def report_monthly_roster(out_path, month, year):
    conn = get_db()
    c    = conn.cursor()

    # Active as-of that month: employed before end of month and either not
    # terminated before the month or rehired by the month end.
    month_start = f"{year:04d}-{month:02d}-01"
    last_day    = calendar.monthrange(year, month)[1]
    month_end   = f"{year:04d}-{month:02d}-{last_day:02d}"

    c.execute("""
        SELECT last_name, first_name, employment_date, position_om, position_ahca
        FROM employees
        WHERE status IN ('active','discharged')
          AND (employment_date IS NULL OR employment_date <= ?)
          AND (
            termination_date IS NULL
            OR termination_date >= ?
            OR (rehired_date IS NOT NULL AND rehired_date <= ?)
          )
        ORDER BY last_name, first_name
    """, (month_end, month_start, month_end))
    rows = c.fetchall()
    conn.close()

    month_name  = datetime.date(year, month, 1).strftime('%B %Y')
    doc_title   = "Monthly Employee Roster"
    doc_sub     = month_name

    doc = SimpleDocTemplate(
        out_path, pagesize=letter,
        leftMargin=0.5*inch, rightMargin=0.5*inch,
        topMargin=1.4*inch, bottomMargin=1.0*inch
    )

    def hf(canvas, doc):
        build_header_footer(canvas, doc, doc_title, doc_sub)

    styles = getSampleStyleSheet()
    story  = []

    # Month label
    style_month = ParagraphStyle('month', fontSize=11, textColor=GREEN_DARK,
                                  fontName='Helvetica-Bold', spaceAfter=8,
                                  alignment=TA_CENTER)
    story.append(Paragraph(f"Employee Signature Roster — {month_name}", style_month))
    story.append(Paragraph(
        f"The employees listed below are required to sign confirming their active status for {month_name}.",
        ParagraphStyle('sub', fontSize=8, textColor=colors.HexColor('#6b6560'),
                        spaceAfter=12, alignment=TA_CENTER)))

    # Table
    col_widths = [0.4*inch, 1.5*inch, 1.5*inch, 1.2*inch, 1.8*inch, 2.1*inch]
    header     = ['#', 'LAST NAME', 'FIRST NAME', 'HIRE DATE', 'POSITION', 'SIGNATURE']

    table_data = [header]
    for idx, row in enumerate(rows, 1):
        table_data.append([
            str(idx),
            row['last_name'] or '',
            row['first_name'] or '',
            fmt_date(row['employment_date']),
            row['position_om'] or row['position_ahca'] or '',
            '',   # blank signature space
        ])

    style = make_table_style()
    # Extra height for signature rows
    style.add('ROWHEIGHT', (0,1), (-1,-1), 22)
    style.add('ALIGN', (0,0), (0,-1), 'CENTER')  # # column centered

    t = Table(table_data, colWidths=col_widths, repeatRows=1)
    t.setStyle(style)
    story.append(t)

    story.append(Spacer(1, 0.15*inch))
    story.append(Paragraph(
        f"Total employees: {len(rows)}",
        ParagraphStyle('footer_note', fontSize=8, textColor=colors.HexColor('#6b6560'),
                        fontName='Helvetica-Oblique')))

    doc.build(story, onFirstPage=hf, onLaterPages=hf)
    return len(rows)

# ═══════════════════════════════════════════════════════════
# REPORT 1b: NEW HIRES (employees hired in a selected month)
# ═══════════════════════════════════════════════════════════
def report_new_hires(out_path, month, year):
    conn = get_db()
    c    = conn.cursor()

    # Employees whose employment_date falls within the selected month,
    # regardless of current status (a hire that month counts even if later discharged).
    month_start = f"{year:04d}-{month:02d}-01"
    last_day    = calendar.monthrange(year, month)[1]
    month_end   = f"{year:04d}-{month:02d}-{last_day:02d}"

    c.execute("""
        SELECT last_name, first_name, employment_date, position_om, position_ahca,
               employment_type, supervisor, status
        FROM employees
        WHERE employment_date IS NOT NULL
          AND employment_date >= ?
          AND employment_date <= ?
        ORDER BY employment_date, last_name, first_name
    """, (month_start, month_end))
    rows = c.fetchall()
    conn.close()

    month_name  = datetime.date(year, month, 1).strftime('%B %Y')
    doc_title   = "New Hires Report"
    doc_sub     = month_name

    doc = SimpleDocTemplate(
        out_path, pagesize=letter,
        leftMargin=0.5*inch, rightMargin=0.5*inch,
        topMargin=1.4*inch, bottomMargin=1.0*inch
    )

    def hf(canvas, doc):
        build_header_footer(canvas, doc, doc_title, doc_sub)

    story  = []

    style_month = ParagraphStyle('month', fontSize=11, textColor=GREEN_DARK,
                                  fontName='Helvetica-Bold', spaceAfter=8,
                                  alignment=TA_CENTER)
    story.append(Paragraph(f"Employees Hired — {month_name}", style_month))
    story.append(Paragraph(
        f"The employees listed below were hired during {month_name}.",
        ParagraphStyle('sub', fontSize=8, textColor=colors.HexColor('#6b6560'),
                        spaceAfter=12, alignment=TA_CENTER)))

    col_widths = [0.4*inch, 1.4*inch, 1.4*inch, 1.0*inch, 1.7*inch, 1.0*inch, 1.6*inch]
    header     = ['#', 'LAST NAME', 'FIRST NAME', 'HIRE DATE', 'POSITION', 'TYPE', 'SUPERVISOR']

    table_data = [header]
    row_styles = []
    for idx, row in enumerate(rows, 1):
        table_data.append([
            str(idx),
            row['last_name'] or '',
            row['first_name'] or '',
            fmt_date(row['employment_date']),
            row['position_om'] or row['position_ahca'] or '',
            row['employment_type'] or '',
            row['supervisor'] or '',
        ])
        # Discharged hire — gray text
        if row['status'] == 'discharged':
            r = len(table_data) - 1
            row_styles.append(('TEXTCOLOR', (0, r), (-1, r), colors.HexColor('#9e9892')))

    style = make_table_style()
    for s in row_styles:
        style.add(*s)
    style.add('ALIGN', (0,0), (0,-1), 'CENTER')  # # column centered

    t = Table(table_data, colWidths=col_widths, repeatRows=1)
    t.setStyle(style)
    story.append(t)

    story.append(Spacer(1, 0.15*inch))
    story.append(Paragraph(
        f"Total new hires: {len(rows)}",
        ParagraphStyle('footer_note', fontSize=8, textColor=colors.HexColor('#6b6560'),
                        fontName='Helvetica-Oblique')))

    doc.build(story, onFirstPage=hf, onLaterPages=hf)
    return len(rows)

# ═══════════════════════════════════════════════════════════
# REPORT 2: LICENSE VERIFICATION ROSTER
# ═══════════════════════════════════════════════════════════
def report_license_verification(out_path):
    conn = get_db()
    c    = conn.cursor()
    c.execute("""
        SELECT last_name, first_name, position_om, position_ahca,
               license_number, license_type, license_state,
               license_issue_date, license_expiration, license_notes
        FROM employees
        WHERE license_number IS NOT NULL AND license_number != '' AND status = 'active'
        ORDER BY last_name, first_name
    """)
    rows = c.fetchall()
    conn.close()

    today   = datetime.date.today()
    in_60   = today + datetime.timedelta(days=60)
    in_30   = today + datetime.timedelta(days=30)

    doc = SimpleDocTemplate(
        out_path, pagesize=landscape(letter),
        leftMargin=0.5*inch, rightMargin=0.5*inch,
        topMargin=1.4*inch, bottomMargin=1.0*inch
    )

    doc_title = "License Verification Roster"
    doc_sub   = f"Active Employees — As of {today.strftime('%B %d, %Y')}"

    def hf(canvas, doc):
        build_header_footer(canvas, doc, doc_title, doc_sub)

    styles = getSampleStyleSheet()
    story  = []

    style_title = ParagraphStyle('t', fontSize=11, textColor=GREEN_DARK,
                                  fontName='Helvetica-Bold', spaceAfter=4, alignment=TA_CENTER)
    story.append(Paragraph("Professional License Verification Roster", style_title))
    story.append(Paragraph(
        "Active employees with professional licenses on file. Expiration dates within 60 days are flagged.",
        ParagraphStyle('s', fontSize=8, textColor=colors.HexColor('#6b6560'),
                        spaceAfter=12, alignment=TA_CENTER)))

    # Landscape: 10in usable — now 9 columns
    col_widths = [0.3*inch, 1.4*inch, 1.3*inch, 1.6*inch, 1.3*inch, 0.9*inch, 1.1*inch, 1.0*inch, 1.1*inch]
    header     = ['#', 'LAST NAME', 'FIRST NAME', 'POSITION', 'LICENSE #',
                  'TYPE', 'STATE', 'ISSUE DATE', 'EXPIRATION']

    table_data = [header]
    row_styles = []

    for idx, row in enumerate(rows, 1):
        exp_str = fmt_date(row['license_expiration'])
        row_color = None
        if row['license_expiration']:
            try:
                exp_dt = datetime.datetime.strptime(row['license_expiration'][:10], '%Y-%m-%d').date()
                if exp_dt <= today:
                    row_color = colors.HexColor('#fdf0f0')
                    exp_str   = f"EXPIRED {exp_str}"
                elif exp_dt <= in_30:
                    row_color = colors.HexColor('#fff3e0')
                    exp_str   = f"!EXP {exp_str}"
                elif exp_dt <= in_60:
                    row_color = colors.HexColor('#fffde7')
            except:
                pass

        note = row['license_notes'] or ''
        lic_display = (row['license_number'] or '')
        if note:
            lic_display += f"\n({note[:20]})"

        table_data.append([
            str(idx),
            row['last_name'] or '',
            row['first_name'] or '',
            row['position_om'] or row['position_ahca'] or '',
            lic_display,
            row['license_type'] or '',
            row['license_state'] or '',
            fmt_date(row['license_issue_date']),
            exp_str,
        ])
        if row_color:
            r = len(table_data) - 1
            row_styles.append(('BACKGROUND', (0, r), (-1, r), row_color))

    style = make_table_style()
    for s in row_styles:
        style.add(*s)
    style.add('ALIGN', (0,0), (0,-1), 'CENTER')
    style.add('FONTNAME', (4,1), (4,-1), 'Helvetica-Bold')  # license # bold

    t = Table(table_data, colWidths=col_widths, repeatRows=1)
    t.setStyle(style)
    story.append(t)

    story.append(Spacer(1, 0.15*inch))
    try:
        expired = sum(1 for r in rows if r['license_expiration'] and
                      datetime.datetime.strptime(r['license_expiration'][:10], '%Y-%m-%d').date() <= today)
    except:
        expired = 0
    story.append(Paragraph(
        f"Total licensed employees: {len(rows)}   |   Expired licenses: {expired}",
        ParagraphStyle('fn', fontSize=8, textColor=colors.HexColor('#6b6560'),
                        fontName='Helvetica-Oblique')))

    doc.build(story, onFirstPage=hf, onLaterPages=hf)
    return len(rows)

# ═══════════════════════════════════════════════════════════
# REPORT 3: FINGERPRINTING ROSTER
# ═══════════════════════════════════════════════════════════
def report_fingerprinting(out_path, include_discharged=True):
    conn = get_db()
    c    = conn.cursor()

    status_filter = "" if include_discharged else "WHERE status = 'active'"
    c.execute(f"""
        SELECT last_name, first_name, dob, position_ahca, position_om,
               employment_date, termination_date, status,
               ahca_background_expiration, medicaid
        FROM employees
        {status_filter}
        ORDER BY last_name, first_name
    """)
    rows = c.fetchall()
    conn.close()

    today   = datetime.date.today()
    doc = SimpleDocTemplate(
        out_path, pagesize=landscape(letter),
        leftMargin=0.5*inch, rightMargin=0.5*inch,
        topMargin=1.4*inch, bottomMargin=1.0*inch
    )

    doc_title = "Fingerprinting / Background Check Roster"
    doc_sub   = f"As of {today.strftime('%B %d, %Y')}"

    def hf(canvas, doc):
        build_header_footer(canvas, doc, doc_title, doc_sub)

    story = []
    style_title = ParagraphStyle('t', fontSize=11, textColor=GREEN_DARK,
                                  fontName='Helvetica-Bold', spaceAfter=4, alignment=TA_CENTER)
    story.append(Paragraph("Employee Fingerprinting / Background Screening Roster", style_title))
    story.append(Paragraph(
        "This roster is for AHCA and Medicaid background screening compliance tracking.",
        ParagraphStyle('s', fontSize=8, textColor=colors.HexColor('#6b6560'),
                        spaceAfter=12, alignment=TA_CENTER)))

    # Landscape: 10in usable
    col_widths = [0.35*inch, 1.5*inch, 1.3*inch, 1.0*inch, 1.1*inch, 1.7*inch,
                  1.2*inch, 1.2*inch, 1.15*inch]
    header = ['#', 'LAST NAME', 'FIRST NAME', 'DOB', 'AGENCY',
              'POSITION', 'HIRE DATE', 'TERM. DATE', 'AHCA BG EXP']

    table_data = [header]
    row_styles = []

    for idx, row in enumerate(rows, 1):
        # Determine agency
        agency_parts = []
        if row['position_ahca']:
            agency_parts.append('AHCA')
        if row['medicaid']:
            agency_parts.append('Medicaid')
        agency = ' / '.join(agency_parts) if agency_parts else 'AHCA'

        bg_exp_str = fmt_date(row['ahca_background_expiration'])
        row_color  = None
        if row['ahca_background_expiration']:
            try:
                exp_dt = datetime.datetime.strptime(row['ahca_background_expiration'][:10], '%Y-%m-%d').date()
                if exp_dt <= today:
                    row_color = colors.HexColor('#fdf0f0')
                    bg_exp_str = f"EXP {bg_exp_str}"
                elif exp_dt <= (today + datetime.timedelta(days=60)):
                    row_color = colors.HexColor('#fff3e0')
            except:
                pass

        table_data.append([
            str(idx),
            row['last_name'] or '',
            row['first_name'] or '',
            fmt_date(row['dob']),
            agency,
            row['position_om'] or row['position_ahca'] or '',
            fmt_date(row['employment_date']),
            fmt_date(row['termination_date']),
            bg_exp_str,
        ])
        if row_color:
            r = len(table_data) - 1
            row_styles.append(('BACKGROUND', (0, r), (-1, r), row_color))

        # Discharged row — gray text
        if row['status'] == 'discharged':
            r = len(table_data) - 1
            row_styles.append(('TEXTCOLOR', (0, r), (-1, r), colors.HexColor('#9e9892')))

    style = make_table_style()
    for s in row_styles:
        style.add(*s)
    style.add('ALIGN', (0,0), (0,-1), 'CENTER')

    t = Table(table_data, colWidths=col_widths, repeatRows=1)
    t.setStyle(style)
    story.append(t)

    story.append(Spacer(1, 0.15*inch))
    active_count = sum(1 for r in rows if r['status'] == 'active')
    story.append(Paragraph(
        f"Total: {len(rows)} employees  ({active_count} active, {len(rows)-active_count} discharged)",
        ParagraphStyle('fn', fontSize=8, textColor=colors.HexColor('#6b6560'),
                        fontName='Helvetica-Oblique')))

    doc.build(story, onFirstPage=hf, onLaterPages=hf)
    return len(rows)

# ═══════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════
if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(json.dumps({'error': 'Usage: generate_report.py <type> <out_path> [args...]'}))
        sys.exit(1)

    rtype    = sys.argv[1]
    out_path = sys.argv[2]

    try:
        if rtype == 'monthly_roster':
            month = int(sys.argv[3]) if len(sys.argv) > 3 else datetime.date.today().month
            year  = int(sys.argv[4]) if len(sys.argv) > 4 else datetime.date.today().year
            count = report_monthly_roster(out_path, month, year)
            print(json.dumps({'ok': True, 'count': count}))

        elif rtype == 'new_hires':
            month = int(sys.argv[3]) if len(sys.argv) > 3 else datetime.date.today().month
            year  = int(sys.argv[4]) if len(sys.argv) > 4 else datetime.date.today().year
            count = report_new_hires(out_path, month, year)
            print(json.dumps({'ok': True, 'count': count}))

        elif rtype == 'license_verification':
            count = report_license_verification(out_path)
            print(json.dumps({'ok': True, 'count': count}))

        elif rtype == 'fingerprinting':
            include_dis = sys.argv[3].lower() == 'true' if len(sys.argv) > 3 else True
            count = report_fingerprinting(out_path, include_dis)
            print(json.dumps({'ok': True, 'count': count}))

        else:
            print(json.dumps({'error': f'Unknown report type: {rtype}'}))
            sys.exit(1)

    except Exception as e:
        import traceback
        print(json.dumps({'error': str(e), 'trace': traceback.format_exc()}))
        sys.exit(1)
