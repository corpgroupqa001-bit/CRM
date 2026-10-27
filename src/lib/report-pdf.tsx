import "server-only";
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { APP_NAME } from "@/lib/format";
import type { ReportTable } from "@/lib/attendance-report";

// X-03 PDF export of a filtered report: landscape A4, the same columns and rows as the screen.

const s = StyleSheet.create({
  page: { padding: 24, fontFamily: "Helvetica", color: "#0f172a" },
  head: { borderBottom: "2 solid #4338ca", paddingBottom: 6, marginBottom: 8 },
  company: { fontSize: 13, fontFamily: "Helvetica-Bold", color: "#1e1b4b" },
  muted: { color: "#64748b", fontSize: 8 },
  th: { flexDirection: "row", backgroundColor: "#eef2ff", fontFamily: "Helvetica-Bold" },
  tr: { flexDirection: "row", borderTop: "1 solid #f1f5f9" },
  foot: { position: "absolute", bottom: 12, left: 24, right: 24, fontSize: 7, color: "#94a3b8", flexDirection: "row", justifyContent: "space-between" },
});

export async function reportPdf(t: ReportTable, company: string, filters: string) {
  // narrow day columns (muster) and wide name columns share the page width
  const width = (c: string) => (/^\d{1,2}(\/\d{1,2})?$/.test(c) ? 1 : c === "Employee" || c === "Department" ? 4 : 2.4);
  const total = t.columns.reduce((a, c) => a + width(c), 0);
  const fontSize = t.columns.length > 20 ? 5.5 : t.columns.length > 12 ? 6.5 : 8;
  const cell = (c: string) => ({ width: `${(width(c) / total) * 100}%`, padding: 2.5, fontSize });
  const doc = (
    <Document title={t.title} author={APP_NAME}>
      <Page size="A4" orientation="landscape" style={s.page} wrap>
        <View style={s.head} fixed>
          <Text style={s.company}>{company}</Text>
          <Text style={{ fontSize: 10, marginTop: 2 }}>{t.title}</Text>
          <Text style={s.muted}>{filters}</Text>
        </View>
        <View style={s.th} fixed>{t.columns.map((c) => <Text key={c} style={cell(c)}>{c}</Text>)}</View>
        {t.rows.length ? t.rows.map((r, i) => (
          <View key={i} style={s.tr} wrap={false}>{r.map((v, j) => <Text key={j} style={cell(t.columns[j])}>{String(v)}</Text>)}</View>
        )) : <Text style={{ fontSize: 9, marginTop: 8 }}>{t.empty}</Text>}
        {t.legend && <Text style={{ ...s.muted, marginTop: 6 }}>{t.legend}</Text>}
        <View style={s.foot} fixed>
          <Text>{APP_NAME} · generated {new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
  return renderToBuffer(doc);
}
