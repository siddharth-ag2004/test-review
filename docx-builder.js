// Builds the Word file: Partially Correct -> Wrong -> Skipped, each sorted by question number.
export const STATUSES = [
  { key: "partial", label: "Partially Correct", heading: "Partially Correct:" },
  { key: "wrong", label: "Wrong", heading: "Wrong:" },
  { key: "skipped", label: "Skipped", heading: "Skipped:" },
];

const MAX_W = 640; // px at 96dpi; A4 with 0.5in margins fits ~698
const MAX_H = 880;

export const byQ = (a, b) => {
  const x = parseInt(a.q, 10);
  const y = parseInt(b.q, 10);
  if (isNaN(x) && isNaN(y)) return 0;
  if (isNaN(x)) return 1;
  if (isNaN(y)) return -1;
  return x - y;
};

/** renderItem(item) -> Promise<{ data: Uint8Array, width, height }> (the cropped JPEG) */
export async function buildDocx(test, renderItem) {
  const { Document, Packer, Paragraph, TextRun, ImageRun } = window.docx;
  const children = [
    new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: test.title, bold: true, size: 32 })] }),
  ];

  // One question per page. A section with questions starts on a fresh page (except the first).
  let wrote = false;
  for (const st of STATUSES) {
    const items = test.items.filter((i) => i.status === st.key).sort(byQ);
    children.push(
      new Paragraph({
        pageBreakBefore: wrote && items.length > 0,
        spacing: { before: 240, after: 120 },
        keepNext: true,
        children: [
          new TextRun({ text: st.heading, bold: true, size: 28, underline: {} }),
          ...(items.length ? [] : [new TextRun({ text: "  None", italics: true, size: 24 })]),
        ],
      })
    );
    for (let n = 0; n < items.length; n++) {
      const it = items[n];
      const img = await renderItem(it);
      const k = Math.min(1.5, MAX_W / img.width, MAX_H / img.height);
      const hasQ = it.q !== "" && it.q != null;
      const breakHere = n > 0; // first question of a section shares the page with its heading
      const imgPara = new Paragraph({
        pageBreakBefore: breakHere && !(hasQ || it.note),
        spacing: { after: 120 },
        children: [
          new ImageRun({
            type: "jpg",
            data: img.data,
            transformation: { width: Math.round(img.width * k), height: Math.round(img.height * k) },
          }),
        ],
      });
      if (hasQ || it.note) {
        children.push(
          new Paragraph({
            pageBreakBefore: breakHere,
            keepNext: true,
            spacing: { before: 160, after: 60 },
            children: [
              ...(hasQ ? [new TextRun({ text: `Q ${it.q}`, bold: true, size: 24 })] : []),
              ...(it.note ? [new TextRun({ text: hasQ ? `   ${it.note}` : it.note, size: 22 })] : []),
            ],
          })
        );
      }
      children.push(imgPara);
      wrote = true;
    }
  }

  const doc = new Document({
    sections: [{ properties: { page: { margin: { top: 720, bottom: 720, left: 720, right: 720 } } }, children }],
  });
  return Packer.toBlob(doc);
}
