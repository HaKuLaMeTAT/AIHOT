"""Bounded, isolated PDF extraction. Only a private pypdf directory and stdin bytes are used."""
import io
import json
import resource
import sys

resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
sys.path.insert(0, sys.argv[1])
try:
    from pypdf import PdfReader
    body = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
    if len(body) > 8 * 1024 * 1024 or not body.startswith(b'%PDF-'):
        raise ValueError('PDF size or signature rejected')
    reader = PdfReader(io.BytesIO(body))
    if reader.is_encrypted or len(reader.pages) > 60:
        raise ValueError('Encrypted PDF or more than 60 pages; index retained')
    parts = []
    for page in reader.pages:
        parts.append(page.extract_text() or '')
        if sum(map(len, parts)) > 60000:
            raise ValueError('PDF text exceeds extraction limit; index retained')
    text = '\n\n'.join(parts).strip()
    if len(text) < 100:
        raise ValueError('PDF has no readable text; OCR is not enabled')
    print(json.dumps({'text': text, 'pages': len(reader.pages)}, ensure_ascii=False))
except Exception as exc:
    print(json.dumps({'error': str(exc)[:200]}, ensure_ascii=False))
    sys.exit(1)
