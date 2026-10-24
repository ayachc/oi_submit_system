const unsupportedEncoding = '无法识别文件编码，请使用 UTF-8、GBK/GB18030 或带 BOM 的 UTF-16 源代码文件。';

function decode(bytes, encoding) {
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

export function decodeSourceBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  let content;
  try {
    // A BOM is explicit: never reinterpret a damaged Unicode file as GBK.
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      content = decode(bytes, 'utf-16le');
    } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      content = decode(bytes, 'utf-16be');
    } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      content = decode(bytes, 'utf-8');
    } else {
      try {
        content = decode(bytes, 'utf-8');
      } catch {
        // GB18030 also covers GBK/GB2312 used by Chinese Windows editors.
        content = decode(bytes, 'gb18030');
      }
    }
  } catch {
    throw new Error(unsupportedEncoding);
  }
  // Reject binary control bytes instead of silently uploading corrupt text.
  if (/[\u0000-\u0008\u000e-\u001f\u007f]/.test(content)) {
    throw new Error('文件包含非文本内容，请选择源代码文件，不要选择编译后的程序。');
  }
  return content;
}

export async function readSourceFile(file) {
  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    throw new Error('无法读取文件，请确认文件仍存在且可以访问，然后重新选择。');
  }
  return decodeSourceBytes(buffer);
}
