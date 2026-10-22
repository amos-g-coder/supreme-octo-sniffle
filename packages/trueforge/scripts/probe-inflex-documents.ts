import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflexConfiguration } from '../src/config';
import { HindsightMemory } from '../src/inflex/memory';
import { runProcess } from '../src/inflex/process';
import { NativeToolSource, nativeToolSet } from '../src/inflex/tools';

const directory = await mkdtemp(path.join(tmpdir(), 'inflex-documents-'));
try {
  const content = 'BT /F1 18 Tf 50 700 Td (Inflex document extraction verified) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${String(Buffer.byteLength(content))} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map(offset => String(offset).padStart(10, '0') + ' 00000 n \n')
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  await writeFile(path.join(directory, 'fixture.pdf'), pdf);
  const tools = nativeToolSet(
    new NativeToolSource({
      root: directory,
      artifacts: path.join(directory, 'artifacts'),
      signal: new AbortController().signal,
      read_only: false,
      owned_paths: undefined,
      memory: new HindsightMemory({ url: undefined, directory: path.join(directory, 'outbox'), fetch }),
      session_id: 'probe',
      project_bank: 'probe',
      memory_access: false,
      worktrees: undefined,
    }),
  );
  const result = await tools.callTool({ name: 'document_read', arguments: { path: 'fixture.pdf' } });
  assert.ok(
    'result' in result &&
      !result.result.isError &&
      result.result.content.some(
        item => item.type === 'text' && item.text.includes('Inflex document extraction verified'),
      ),
    JSON.stringify(result),
  );
  const generated = await runProcess({
    command: inflexConfiguration.ffmpeg,
    args: [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=white:s=960x160:d=1',
      '-vf',
      "drawtext=text='INFLEX VERIFIED':fontsize=64:fontcolor=black:x=30:y=40",
      '-frames:v',
      '1',
      '-threads',
      '1',
      '-y',
      path.join(directory, 'scan.png'),
    ],
    cwd: directory,
    signal: new AbortController().signal,
  });
  assert.equal(generated.exit_code, 0, generated.stderr);
  const ocr = await tools.callTool({ name: 'document_ocr', arguments: { path: 'scan.png' } });
  assert.ok(
    'result' in ocr &&
      !ocr.result.isError &&
      ocr.result.content.some(item => item.type === 'text' && item.text.includes('INFLEX VERIFIED')),
    JSON.stringify(ocr),
  );
  console.log(
    JSON.stringify({
      passed: true,
      engines: ['MarkItDown', 'Tesseract'],
      pdf_text_extracted: true,
      image_text_extracted: true,
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
