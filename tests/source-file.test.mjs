import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSourceBytes, readSourceFile } from '../public/source-file.js';

const source = '// 中文\r\nint main() { return 0; }\r\n';
const gbkSource = Buffer.concat([
  Buffer.from('// '), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
  Buffer.from('\r\nint main() { return 0; }\r\n'),
]);

test('UTF-8 source, ASCII and optional BOM preserve source text and line endings', () => {
  assert.equal(decodeSourceBytes(Buffer.from(source)), source);
  assert.equal(decodeSourceBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source)])), source);
  const ascii = '#include <iostream>\r\nint main() { return 0; }\r\n';
  assert.equal(decodeSourceBytes(Buffer.from(ascii)), ascii);
});

test('Chinese Windows ANSI/GBK source decodes comments without replacement characters', () => {
  assert.equal(decodeSourceBytes(gbkSource), source);
  assert.equal(decodeSourceBytes(Buffer.from([0xc4, 0xe3, 0xba, 0xc3])), '你好');
});

test('GB18030 four-byte characters are supported', () => {
  assert.equal(decodeSourceBytes(Buffer.from([0x94, 0x39, 0xfc, 0x36])), '😀');
});

test('Windows Unicode files with UTF-16LE or UTF-16BE BOM decode correctly', () => {
  const utf16 = Buffer.from(source, 'utf16le');
  assert.equal(decodeSourceBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), utf16])), source);
  assert.equal(decodeSourceBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(utf16).swap16()])), source);
});

test('binary files and BOM-less UTF-16 are rejected instead of corrupting code', () => {
  for (const bytes of [Buffer.from('MZ\0\0program'), Buffer.from('int main(){}', 'utf16le'), Buffer.from([0x01, 0x02, 0x03])]) {
    assert.throws(() => decodeSourceBytes(bytes), /非文本/);
  }
});

test('malformed input and damaged Unicode BOM files never silently fall back', () => {
  for (const bytes of [Buffer.from([0x81]), Buffer.from([0xff]), Buffer.from([0xef, 0xbb, 0xbf, 0xd6, 0xd0]), Buffer.from([0xff, 0xfe, 0x61]), Buffer.from([0xfe, 0xff, 0xd8, 0x00])]) {
    assert.throws(() => decodeSourceBytes(bytes), /无法识别文件编码/);
  }
});

test('empty and whitespace-only files stay empty for submission validation', () => {
  assert.equal(decodeSourceBytes(new ArrayBuffer(0)), '');
  assert.equal(decodeSourceBytes(Buffer.from([0xef, 0xbb, 0xbf])), '');
  assert.equal(decodeSourceBytes(Buffer.from(' \t\r\n')), ' \t\r\n');
});

test('file reading failures have an actionable message distinct from encoding failures', async () => {
  assert.equal(await readSourceFile(new Blob([gbkSource])), source);
  await assert.rejects(() => readSourceFile({ arrayBuffer: async () => { throw new Error('NotReadableError'); } }), /文件仍存在且可以访问/);
  await assert.rejects(() => readSourceFile(new Blob([Buffer.from([0xff])])), /无法识别文件编码/);
});
