import { readFileSync } from 'node:fs';

// Prebuilt shards keep ordinary packing dependency-free. Include only shards that
// cover the source document (including collapsed panels, DSL labels and templates).
export function inlineFonts(source) {
  const root = new URL('./fonts/', import.meta.url);
  const faces = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
  const decoded = source.replace(/&#(x[0-9a-f]+|\d+);/gi, (text, number) => {
    const cp = number[0].toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : text;
  });
  const points = [...new Set([...decoded].map((c) => c.codePointAt(0)))];
  const css = faces.filter((face) => {
    if (!face.range) return true;
    const ranges = face.range.split(',').map((range) => {
      const [start, end = start] = range.slice(2).split('-');
      return [parseInt(start, 16), parseInt(end, 16)];
    });
    return points.some((cp) => ranges.some(([start, end]) => cp >= start && cp <= end));
  }).map((face) => {
    const data = readFileSync(new URL(face.file, root)).toString('base64');
    return `@font-face{font-family:"${face.family}";font-style:normal;font-weight:${face.weight};font-display:swap;src:url(data:font/woff2;base64,${data}) format("woff2");${face.range ? `unicode-range:${face.range};` : ''}}`;
  });
  const notices = ['source-han-sans-OFL.txt', 'inter-OFL.txt', 'JetBrainsMono-OFL.txt']
    .map((file) => readFileSync(new URL(file, root), 'utf8')).join('\n\n');
  return `/* Bundled font licenses\n${notices.replaceAll('*/', '* /')}\n*/\n${css.join('\n')}`;
}
