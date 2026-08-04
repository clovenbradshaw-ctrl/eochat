// file-formats.js — the one place that knows how to turn an arbitrary file
// into something this app can show and, where a real parse exists, index.
//
// Before this module the upload path recognised eleven text extensions, .pdf,
// .xlsx/.xls and images; everything else — a .docx, a .epub, a .zip, a .go
// file, a .ini, a .tar.gz, a file with no extension at all — was dropped into
// one bucket called "binary", stored as a blob URL and rendered by the reader
// as an empty panel. Two different failures were hiding in that bucket:
//
//   1. Files that ARE text but whose extension wasn't on the list. A .rs, a
//      .toml, a .sql, a Dockerfile: perfectly readable UTF-8 that the app
//      refused to read because it was checking the name instead of the bytes.
//   2. Files that are real containers with a real, parseable text layer —
//      DOCX, PPTX, ODT, EPUB, ZIP, TAR — which needed a parser, not a bucket.
//
// Both are answered here, and both keep the discipline the rest of the app
// keeps (LAWS.md, and the nameless-referent principle in ../INSTRUCTION-LAW.md):
// a format we can genuinely parse is parsed and ingested; a format we cannot is
// a NAMED gap — identified by its magic bytes, sized, shown as a hex dump and
// as its printable strings — never mangled into fake text that would corrupt
// the search index with mojibake nobody could trace back to a cause.
//
// Zero new dependencies. ZIP containers are read with the platform's own
// DecompressionStream (deflate-raw), TAR with its 512-byte header format, XML
// with DOMParser. When DecompressionStream is missing (an older browser), a
// ZIP's STORED entries still read and its deflated ones become a named gap —
// degraded, still honest, never silently empty.
//
// Loaded as a module the same way webllm-client.js is, and published on
// window.EOFormats because the dc-runtime Component in index.html is eval'd as
// a plain script and cannot `import`.

// ── Caps ────────────────────────────────────────────────────────────────────
// Every one of these bounds a thing that could otherwise hang the tab on a
// pathological file. They are generous enough that no ordinary document meets
// them, and when one IS met the result says so rather than silently stopping.
const MAX_TEXT_DECODE = 64 * 1024 * 1024;   // bytes decoded as text in one go
const MAX_SNIFF = 65536;                    // bytes read to identify a format
const MAX_ARCHIVE_ENTRIES = 4000;           // entries listed from one archive
const MAX_ARCHIVE_TEXT = 8 * 1024 * 1024;   // total text pulled out of members
const MAX_ARCHIVE_MEMBER = 2 * 1024 * 1024; // largest single member read as text
const MAX_HEX_BYTES = 4096;                 // bytes shown in the hex dump
const MAX_STRINGS = 4000;                   // printable runs shown for a binary
const MIN_STRING_RUN = 4;                   // shortest run that counts as a string

// ── Kind taxonomy ───────────────────────────────────────────────────────────
// A "kind" answers one question: how should the reader SHOW this? Everything
// text-shaped (prose, code, data, extracted documents) shares one renderer;
// image, video, audio, archive and binary each have their own.
const TEXT_SHAPED = new Set(['text', 'code', 'data', 'pdf', 'document', 'presentation', 'ebook', 'notebook', 'email', 'subtitle', 'spreadsheet']);

// Extension → kind. The list is long on purpose: every entry here is a file
// someone plausibly drops on a research tool, and an extension we recognise
// gets a right answer without having to sniff bytes at all. An extension we do
// NOT recognise is not a dead end — extract() still decodes the bytes and, if
// they are text, reads them as text. The list is an accelerator, not a gate.
const EXT_KIND = {
  // prose / markup
  txt: 'text', text: 'text', md: 'text', markdown: 'text', mdx: 'text',
  rst: 'text', adoc: 'text', asciidoc: 'text', org: 'text', tex: 'text',
  latex: 'text', bib: 'text', nfo: 'text', me: 'text', readme: 'text',
  log: 'text', diff: 'text', patch: 'text', po: 'text', pot: 'text',
  // code
  js: 'code', mjs: 'code', cjs: 'code', jsx: 'code', ts: 'code', tsx: 'code',
  py: 'code', pyw: 'code', rb: 'code', rs: 'code', go: 'code', java: 'code',
  kt: 'code', kts: 'code', scala: 'code', swift: 'code', m: 'code', mm: 'code',
  c: 'code', h: 'code', cc: 'code', cpp: 'code', cxx: 'code', hpp: 'code',
  hh: 'code', hxx: 'code', cs: 'code', fs: 'code', fsx: 'code', vb: 'code',
  php: 'code', pl: 'code', pm: 'code', lua: 'code', r: 'code', jl: 'code',
  dart: 'code', ex: 'code', exs: 'code', erl: 'code', hrl: 'code',
  hs: 'code', lhs: 'code', ml: 'code', mli: 'code', clj: 'code', cljs: 'code',
  edn: 'code', lisp: 'code', el: 'code', scm: 'code', rkt: 'code',
  sh: 'code', bash: 'code', zsh: 'code', fish: 'code', ps1: 'code',
  bat: 'code', cmd: 'code', awk: 'code', sed: 'code', vim: 'code',
  sql: 'code', graphql: 'code', gql: 'code', proto: 'code', thrift: 'code',
  sol: 'code', zig: 'code', nim: 'code', v: 'code', d: 'code', cr: 'code',
  groovy: 'code', gradle: 'code', tf: 'code', hcl: 'code', nix: 'code',
  asm: 'code', s: 'code', wat: 'code', f: 'code', f90: 'code', for: 'code',
  pas: 'code', ada: 'code', cob: 'code', tcl: 'code', ahk: 'code',
  css: 'code', scss: 'code', sass: 'code', less: 'code', styl: 'code',
  vue: 'code', svelte: 'code', astro: 'code', hbs: 'code', ejs: 'code',
  pug: 'code', jade: 'code', haml: 'code', erb: 'code', twig: 'code',
  html: 'code', htm: 'code', xhtml: 'code', xml: 'code', xsl: 'code',
  xslt: 'code', svg: 'image', dtd: 'code', wsdl: 'code', plist: 'code',
  // structured data / config
  json: 'data', json5: 'data', jsonl: 'data', ndjson: 'data', geojson: 'data',
  yaml: 'data', yml: 'data', toml: 'data', ini: 'data', cfg: 'data',
  conf: 'data', properties: 'data', env: 'data', editorconfig: 'data',
  lock: 'data', sarif: 'data', har: 'data', rdf: 'data', ttl: 'data',
  // tabular
  csv: 'spreadsheet', tsv: 'spreadsheet', psv: 'spreadsheet',
  xlsx: 'spreadsheet', xlsm: 'spreadsheet', xlsb: 'spreadsheet', xls: 'spreadsheet',
  ods: 'spreadsheet', numbers: 'spreadsheet',
  // documents
  pdf: 'pdf',
  docx: 'document', docm: 'document', dotx: 'document', doc: 'document',
  odt: 'document', ott: 'document', rtf: 'document', pages: 'document',
  wpd: 'document', abw: 'document',
  // presentations
  pptx: 'presentation', pptm: 'presentation', ppsx: 'presentation',
  potx: 'presentation', ppt: 'presentation', odp: 'presentation', key: 'presentation',
  // books
  epub: 'ebook', mobi: 'ebook', azw: 'ebook', azw3: 'ebook', fb2: 'ebook', djvu: 'ebook',
  // notebooks
  ipynb: 'notebook',
  // mail
  eml: 'email', mbox: 'email', msg: 'email',
  // subtitles
  srt: 'subtitle', vtt: 'subtitle', ass: 'subtitle', ssa: 'subtitle', sub: 'subtitle',
  // media
  png: 'image', jpg: 'image', jpeg: 'image', jfif: 'image', gif: 'image',
  webp: 'image', bmp: 'image', ico: 'image', tif: 'image', tiff: 'image',
  avif: 'image', heic: 'image', heif: 'image', jxl: 'image', psd: 'image',
  mp4: 'video', m4v: 'video', mov: 'video', webm: 'video', mkv: 'video',
  avi: 'video', wmv: 'video', flv: 'video', mpg: 'video', mpeg: 'video', ogv: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio',
  oga: 'audio', opus: 'audio', flac: 'audio', aiff: 'audio', aif: 'audio',
  wma: 'audio', mid: 'audio', midi: 'audio', amr: 'audio',
  // archives
  zip: 'archive', jar: 'archive', war: 'archive', ear: 'archive', apk: 'archive',
  ipa: 'archive', xpi: 'archive', crx: 'archive', whl: 'archive', egg: 'archive',
  tar: 'archive', gz: 'archive', tgz: 'archive', bz2: 'archive', tbz: 'archive',
  xz: 'archive', txz: 'archive', zst: 'archive', lz4: 'archive', br: 'archive',
  '7z': 'archive', rar: 'archive', cab: 'archive', iso: 'archive', dmg: 'archive',
  deb: 'archive', rpm: 'archive',
  // fonts / executables / other binaries — named, not parsed
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font', eot: 'font',
  exe: 'binary', dll: 'binary', so: 'binary', dylib: 'binary', bin: 'binary',
  wasm: 'binary', class: 'binary', o: 'binary', a: 'binary', db: 'binary',
  sqlite: 'binary', sqlite3: 'binary', pyc: 'binary', pdb: 'binary',
};

// Filenames with no extension that are nonetheless well known text — build
// files, the conventional repo documents, and dotfiles (matched by their name
// with the leading dot stripped; see stemOf).
const BARE_NAME_KIND = {
  dockerfile: 'code', makefile: 'code', rakefile: 'code', gemfile: 'code',
  procfile: 'code', brewfile: 'code', justfile: 'code', vagrantfile: 'code',
  jenkinsfile: 'code', cmakelists: 'code', license: 'text', licence: 'text',
  readme: 'text', changelog: 'text', authors: 'text', contributing: 'text',
  notice: 'text', copying: 'text', todo: 'text', install: 'text', news: 'text',
  gitignore: 'data', gitattributes: 'data', gitmodules: 'data', gitconfig: 'data',
  dockerignore: 'data', npmignore: 'data', eslintignore: 'data', prettierignore: 'data',
  npmrc: 'data', nvmrc: 'data', yarnrc: 'data', babelrc: 'data', editorconfig: 'data',
  eslintrc: 'data', prettierrc: 'data', env: 'data', htaccess: 'data',
  bashrc: 'code', zshrc: 'code', profile: 'code', bash_profile: 'code', vimrc: 'code',
};

// ── Magic bytes ─────────────────────────────────────────────────────────────
// Extensions lie and sometimes don't exist. These are what the file actually
// says it is. `offset` is where the signature sits; `id` and `label` are what
// the reader is told when no parser exists, so that "we can't read this" is
// still a specific statement about a specific format.
const SIGNATURES = [
  { off: 0, hex: '89504e470d0a1a0a', id: 'png', label: 'PNG image', kind: 'image', mime: 'image/png' },
  { off: 0, hex: 'ffd8ff', id: 'jpeg', label: 'JPEG image', kind: 'image', mime: 'image/jpeg' },
  { off: 0, hex: '474946383961', id: 'gif', label: 'GIF image', kind: 'image', mime: 'image/gif' },
  { off: 0, hex: '474946383761', id: 'gif', label: 'GIF image', kind: 'image', mime: 'image/gif' },
  { off: 0, hex: '424d', id: 'bmp', label: 'BMP image', kind: 'image', mime: 'image/bmp' },
  { off: 0, hex: '49492a00', id: 'tiff', label: 'TIFF image', kind: 'image', mime: 'image/tiff' },
  { off: 0, hex: '4d4d002a', id: 'tiff', label: 'TIFF image', kind: 'image', mime: 'image/tiff' },
  { off: 0, hex: '00000100', id: 'ico', label: 'Windows icon', kind: 'image', mime: 'image/x-icon' },
  { off: 0, hex: '38425053', id: 'psd', label: 'Photoshop document', kind: 'binary', mime: 'image/vnd.adobe.photoshop' },
  { off: 0, hex: '25504446', id: 'pdf', label: 'PDF document', kind: 'pdf', mime: 'application/pdf' },
  { off: 0, hex: '504b0304', id: 'zip', label: 'ZIP container', kind: 'archive', mime: 'application/zip' },
  { off: 0, hex: '504b0506', id: 'zip', label: 'ZIP container (empty)', kind: 'archive', mime: 'application/zip' },
  { off: 0, hex: '504b0708', id: 'zip', label: 'ZIP container (spanned)', kind: 'archive', mime: 'application/zip' },
  { off: 0, hex: '1f8b', id: 'gzip', label: 'gzip stream', kind: 'archive', mime: 'application/gzip' },
  { off: 0, hex: '425a68', id: 'bzip2', label: 'bzip2 archive', kind: 'archive', mime: 'application/x-bzip2' },
  { off: 0, hex: 'fd377a585a00', id: 'xz', label: 'xz archive', kind: 'archive', mime: 'application/x-xz' },
  { off: 0, hex: '28b52ffd', id: 'zstd', label: 'Zstandard archive', kind: 'archive', mime: 'application/zstd' },
  { off: 0, hex: '377abcaf271c', id: '7z', label: '7-Zip archive', kind: 'archive', mime: 'application/x-7z-compressed' },
  { off: 0, hex: '526172211a07', id: 'rar', label: 'RAR archive', kind: 'archive', mime: 'application/vnd.rar' },
  { off: 257, hex: '7573746172', id: 'tar', label: 'TAR archive', kind: 'archive', mime: 'application/x-tar' },
  { off: 0, hex: '4d534346', id: 'cab', label: 'Microsoft Cabinet', kind: 'archive', mime: 'application/vnd.ms-cab-compressed' },
  { off: 0, hex: '213c617263683e', id: 'ar', label: 'ar archive (.deb/.a)', kind: 'archive', mime: 'application/x-archive' },
  { off: 0, hex: 'd0cf11e0a1b11ae1', id: 'ole2', label: 'OLE2 compound file (legacy Office)', kind: 'document', mime: 'application/x-ole-storage' },
  { off: 0, hex: '7b5c72746631', id: 'rtf', label: 'RTF document', kind: 'document', mime: 'application/rtf' },
  { off: 0, hex: '53514c69746520666f726d6174203300', id: 'sqlite', label: 'SQLite database', kind: 'binary', mime: 'application/vnd.sqlite3' },
  { off: 0, hex: '7f454c46', id: 'elf', label: 'ELF executable', kind: 'binary', mime: 'application/x-elf' },
  { off: 0, hex: '4d5a', id: 'pe', label: 'Windows executable (PE)', kind: 'binary', mime: 'application/vnd.microsoft.portable-executable' },
  { off: 0, hex: 'cafebabe', id: 'class', label: 'Java class file', kind: 'binary', mime: 'application/java-vm' },
  { off: 0, hex: 'feedface', id: 'macho', label: 'Mach-O executable', kind: 'binary', mime: 'application/x-mach-binary' },
  { off: 0, hex: 'feedfacf', id: 'macho', label: 'Mach-O executable (64-bit)', kind: 'binary', mime: 'application/x-mach-binary' },
  { off: 0, hex: '0061736d', id: 'wasm', label: 'WebAssembly module', kind: 'binary', mime: 'application/wasm' },
  { off: 0, hex: '644558', id: 'dex', label: 'Android DEX', kind: 'binary', mime: 'application/x-dex' },
  { off: 0, hex: '00010000', id: 'ttf', label: 'TrueType font', kind: 'font', mime: 'font/ttf' },
  { off: 0, hex: '4f54544f', id: 'otf', label: 'OpenType font', kind: 'font', mime: 'font/otf' },
  { off: 0, hex: '774f4646', id: 'woff', label: 'WOFF font', kind: 'font', mime: 'font/woff' },
  { off: 0, hex: '774f4632', id: 'woff2', label: 'WOFF2 font', kind: 'font', mime: 'font/woff2' },
  { off: 0, hex: '52494646', id: 'riff', label: 'RIFF container (WAV/AVI/WebP)', kind: 'binary', mime: 'application/octet-stream' },
  { off: 0, hex: '4f676753', id: 'ogg', label: 'Ogg container', kind: 'audio', mime: 'audio/ogg' },
  { off: 0, hex: '664c6143', id: 'flac', label: 'FLAC audio', kind: 'audio', mime: 'audio/flac' },
  { off: 0, hex: '494433', id: 'mp3', label: 'MP3 audio', kind: 'audio', mime: 'audio/mpeg' },
  { off: 0, hex: '4d546864', id: 'midi', label: 'MIDI sequence', kind: 'audio', mime: 'audio/midi' },
  { off: 4, hex: '66747970', id: 'isobmff', label: 'ISO base media (MP4/MOV/HEIC)', kind: 'video', mime: 'video/mp4' },
  { off: 0, hex: '1a45dfa3', id: 'matroska', label: 'Matroska/WebM container', kind: 'video', mime: 'video/webm' },
  { off: 0, hex: '000001ba', id: 'mpeg-ps', label: 'MPEG program stream', kind: 'video', mime: 'video/mpeg' },
  { off: 0, hex: '000001b3', id: 'mpeg-vs', label: 'MPEG video stream', kind: 'video', mime: 'video/mpeg' },
  { off: 0, hex: '41542654464f524d', id: 'aiff', label: 'AIFF audio', kind: 'audio', mime: 'audio/aiff' },
  { off: 0, hex: 'd4c3b2a1', id: 'pcap', label: 'pcap capture', kind: 'binary', mime: 'application/vnd.tcpdump.pcap' },
  { off: 0, hex: '0a0d0d0a', id: 'pcapng', label: 'pcapng capture', kind: 'binary', mime: 'application/x-pcapng' },
  { off: 0, hex: '62706c697374', id: 'bplist', label: 'Binary property list', kind: 'binary', mime: 'application/x-plist' },
  { off: 0, hex: '4b444d', id: 'vmdk', label: 'VMDK disk image', kind: 'binary', mime: 'application/octet-stream' },
  { off: 32769, hex: '4344303031', id: 'iso9660', label: 'ISO 9660 disc image', kind: 'archive', mime: 'application/x-iso9660-image' },
];

const KIND_GLYPH = {
  text: '●', code: '⌗', data: '⌗', pdf: '●', document: '▤', presentation: '▨',
  ebook: '▥', notebook: '▤', email: '✉', subtitle: '⌇', spreadsheet: '▦',
  image: '◱', video: '●', audio: '○', archive: '▩', font: 'A', binary: '◱', link: '○',
};
const KIND_LABEL = {
  text: 'Text', code: 'Code', data: 'Data', pdf: 'PDF', document: 'Document',
  presentation: 'Slides', ebook: 'Book', notebook: 'Notebook', email: 'Email',
  subtitle: 'Captions', spreadsheet: 'Sheet', image: 'Image', video: 'Video',
  audio: 'Audio', archive: 'Archive', font: 'Font', binary: 'File', link: 'Article',
};

// ── Small helpers ───────────────────────────────────────────────────────────
// A dotfile's leading dot is not an extension separator — `.gitignore` is a
// file named "gitignore", not a file of type "gitignore". Reading it the naive
// way made every dotfile an unknown format that had to be sniffed byte by byte
// and then reported as "not a format this app knows", which is false: these
// are among the most recognisable files there are.
const isDotfile = (base) => base.startsWith('.') && base.indexOf('.', 1) === -1;
const extOf = (name) => {
  const base = String(name || '').replace(/^.*[/\\]/, '').toLowerCase();
  if (isDotfile(base)) return '';
  const m = base.match(/\.([a-z0-9_]+)$/);
  return m ? m[1] : '';
};
const baseOf = (name) => String(name || '').replace(/^.*[/\\]/, '');
const stemOf = (name) => {
  const base = baseOf(name).toLowerCase();
  return isDotfile(base) ? base.slice(1) : base.replace(/\.[^.]*$/, '');
};

function bytesMatch(bytes, off, hex) {
  const need = hex.length / 2;
  if (bytes.length < off + need) return false;
  for (let i = 0; i < need; i++) {
    if (bytes[off + i] !== parseInt(hex.substr(i * 2, 2), 16)) return false;
  }
  return true;
}

function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ── Text decoding ───────────────────────────────────────────────────────────
// The single most useful thing in this file: a file whose extension we have
// never seen is still read, correctly, if its bytes are text. Encoding is
// decided by evidence in this order — a BOM (unambiguous), a strict UTF-8
// decode (self-validating: invalid sequences throw), a UTF-16 pattern test
// (alternating NULs), then Windows-1252 as the last resort for legacy 8-bit
// text. If none of those produce something that looks like text, we say so and
// return null; the caller then treats the file as the binary it is instead of
// ingesting garbage.
function decodeText(bytes) {
  if (!bytes || !bytes.length) return { text: '', encoding: 'empty' };
  if (bytes.length > MAX_TEXT_DECODE) return null;

  // BOMs are a declaration by the writer — believe them.
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return tryDecoder(bytes.subarray(3), 'utf-8', 'UTF-8 (BOM)');
  }
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return tryDecoder(bytes.subarray(2), 'utf-16le', 'UTF-16 LE (BOM)');
  }
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    return tryDecoder(bytes.subarray(2), 'utf-16be', 'UTF-16 BE (BOM)');
  }

  // Strict UTF-8 validates itself: a byte sequence that isn't UTF-8 throws
  // rather than silently producing U+FFFD, which is exactly the difference
  // between reading a file and corrupting it.
  const utf8 = tryDecoder(bytes, 'utf-8', 'UTF-8', true);
  if (utf8 && looksLikeText(utf8.text)) return utf8;

  // No BOM but every other byte is NUL is UTF-16 in practice (Windows tools
  // emit this constantly). Which endianness is decided by which half is NUL.
  const probe = bytes.subarray(0, Math.min(bytes.length, 4096));
  let evenNul = 0, oddNul = 0, pairs = 0;
  for (let i = 0; i + 1 < probe.length; i += 2) {
    pairs++;
    if (probe[i] === 0) evenNul++;
    if (probe[i + 1] === 0) oddNul++;
  }
  if (pairs > 8 && oddNul / pairs > 0.7 && evenNul / pairs < 0.2) {
    const r = tryDecoder(bytes, 'utf-16le', 'UTF-16 LE');
    if (r && looksLikeText(r.text)) return r;
  }
  if (pairs > 8 && evenNul / pairs > 0.7 && oddNul / pairs < 0.2) {
    const r = tryDecoder(bytes, 'utf-16be', 'UTF-16 BE');
    if (r && looksLikeText(r.text)) return r;
  }

  // Legacy 8-bit text. Only accepted when the byte histogram already looks
  // like prose — windows-1252 will "decode" absolutely anything, so it is the
  // one decoder whose output cannot be trusted on its own.
  if (looksLikeEightBitText(bytes)) {
    const r = tryDecoder(bytes, 'windows-1252', 'Windows-1252');
    if (r && looksLikeText(r.text)) return r;
  }
  return null;
}

function tryDecoder(bytes, encoding, label, fatal = false) {
  try {
    const dec = new TextDecoder(encoding, { fatal });
    return { text: dec.decode(bytes), encoding: label };
  } catch {
    return null;
  }
}

// A decode succeeded mechanically; this asks whether the RESULT is text.
// Control characters outside the handful that legitimately appear in text
// files (tab, newline, carriage return, form feed) are the tell.
function looksLikeText(text) {
  if (!text) return true;
  const sample = text.length > 8192 ? text.slice(0, 8192) : text;
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || c === 12) continue;
    if (c < 32 || c === 0xFFFD) bad++;
  }
  return bad / sample.length < 0.05;
}

function looksLikeEightBitText(bytes) {
  const probe = bytes.subarray(0, Math.min(bytes.length, 8192));
  let printable = 0;
  for (let i = 0; i < probe.length; i++) {
    const b = probe[i];
    if (b === 0) return false;                       // NUL never appears in 8-bit text
    if (b === 9 || b === 10 || b === 13 || b === 12) { printable++; continue; }
    if (b >= 32) printable++;
  }
  return printable / probe.length > 0.92;
}

// ── Binary surfaces: hex + strings ──────────────────────────────────────────
// What a file that has no parser can still honestly show. Neither of these is
// an interpretation: the hex dump is the bytes, and the strings view is the
// runs of printable characters that are literally present, labelled as such so
// nobody mistakes it for a document. Neither is ever ingested — a strings dump
// in the search index would be a citable passage nobody wrote.
function hexDump(bytes, maxBytes = MAX_HEX_BYTES) {
  const n = Math.min(bytes.length, maxBytes);
  const lines = [];
  for (let off = 0; off < n; off += 16) {
    const row = bytes.subarray(off, Math.min(off + 16, n));
    let hex = '', ascii = '';
    for (let i = 0; i < 16; i++) {
      hex += i < row.length ? row[i].toString(16).padStart(2, '0') : '  ';
      hex += i === 7 ? '  ' : ' ';
      if (i < row.length) ascii += row[i] >= 32 && row[i] < 127 ? String.fromCharCode(row[i]) : '.';
    }
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex} |${ascii}|`);
  }
  return { text: lines.join('\n'), shown: n, total: bytes.length, truncated: n < bytes.length };
}

function printableStrings(bytes, minRun = MIN_STRING_RUN, limit = MAX_STRINGS) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= minRun && out.length < limit) out.push(String.fromCharCode(...run));
    run = [];
  };
  for (let i = 0; i < bytes.length && out.length < limit; i++) {
    const b = bytes[i];
    if (b >= 32 && b < 127) run.push(b);
    else flush();
  }
  flush();
  return { strings: out, truncated: out.length >= limit };
}

// ── ZIP ─────────────────────────────────────────────────────────────────────
// Read from the central directory (the authoritative index at the end of the
// file) rather than by walking local headers forward, because the central
// directory is the only place that is correct for a ZIP written by a streaming
// writer — local headers there carry zeroed sizes and defer to a data
// descriptor. DOCX, XLSX, PPTX, ODT, EPUB, JAR, APK and .whl are all this.
const ZIP_EOCD = 0x06054b50, ZIP_CD = 0x02014b50, ZIP64_EOCD_LOC = 0x07064b50, ZIP64_EOCD = 0x06064b50;

function u16(dv, o) { return dv.getUint16(o, true); }
function u32(dv, o) { return dv.getUint32(o, true); }
function u64(dv, o) {
  // ZIP64 sizes are 64-bit; JS numbers are exact to 2^53, which is 8 petabytes
  // — beyond anything a browser tab is going to hold, so the low/high split is
  // safe here without BigInt.
  return dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 0x100000000;
}

function findEOCD(dv, len) {
  const scan = Math.min(len, 66560); // 64KB comment ceiling + the record itself
  for (let i = len - 22; i >= len - scan && i >= 0; i--) {
    if (u32(dv, i) === ZIP_EOCD) return i;
  }
  return -1;
}

function readZipDirectory(buf) {
  const dv = new DataView(buf);
  const len = buf.byteLength;
  const eocd = findEOCD(dv, len);
  if (eocd < 0) throw new Error('not a ZIP container (no end-of-central-directory record)');

  let count = u16(dv, eocd + 10);
  let cdOffset = u32(dv, eocd + 16);

  // ZIP64: the 32-bit fields saturate and the real values live in a separate
  // record pointed at by a locator immediately before the EOCD.
  if (count === 0xFFFF || cdOffset === 0xFFFFFFFF) {
    const locOff = eocd - 20;
    if (locOff >= 0 && u32(dv, locOff) === ZIP64_EOCD_LOC) {
      const z64 = u64(dv, locOff + 8);
      if (z64 >= 0 && z64 + 56 <= len && u32(dv, z64) === ZIP64_EOCD) {
        count = u64(dv, z64 + 32);
        cdOffset = u64(dv, z64 + 48);
      }
    }
  }

  const entries = [];
  let p = cdOffset;
  const nameDec = new TextDecoder('utf-8');
  for (let i = 0; i < count && p + 46 <= len; i++) {
    if (u32(dv, p) !== ZIP_CD) break;
    const method = u16(dv, p + 10);
    let compressedSize = u32(dv, p + 20);
    let size = u32(dv, p + 24);
    const nameLen = u16(dv, p + 28);
    const extraLen = u16(dv, p + 30);
    const commentLen = u16(dv, p + 32);
    let localOffset = u32(dv, p + 42);
    const name = nameDec.decode(new Uint8Array(buf, p + 46, nameLen));

    // ZIP64 extended information extra field (0x0001) supplies whichever of
    // the three fields saturated, in a fixed order, only for those that did.
    if (size === 0xFFFFFFFF || compressedSize === 0xFFFFFFFF || localOffset === 0xFFFFFFFF) {
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = u16(dv, e), sz = u16(dv, e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xFFFFFFFF) { size = u64(dv, q); q += 8; }
          if (compressedSize === 0xFFFFFFFF) { compressedSize = u64(dv, q); q += 8; }
          if (localOffset === 0xFFFFFFFF) { localOffset = u64(dv, q); q += 8; }
          break;
        }
        e += 4 + sz;
      }
    }

    entries.push({ name, size, compressedSize, method, localOffset, dir: name.endsWith('/') });
    p += 46 + nameLen + extraLen + commentLen;
    if (entries.length >= MAX_ARCHIVE_ENTRIES) break;
  }
  return entries;
}

async function inflateRaw(u8) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('this browser has no DecompressionStream — deflated ZIP members cannot be read');
  }
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(u8) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('this browser has no DecompressionStream — gzip streams cannot be read');
  }
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipEntry(buf, entry) {
  const dv = new DataView(buf);
  const lo = entry.localOffset;
  if (lo + 30 > buf.byteLength || u32(dv, lo) !== 0x04034b50) {
    throw new Error(`local header for "${entry.name}" is not where the directory says it is`);
  }
  const nameLen = u16(dv, lo + 26), extraLen = u16(dv, lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = new Uint8Array(buf, start, Math.min(entry.compressedSize, buf.byteLength - start));
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRaw(raw);
  throw new Error(`compression method ${entry.method} is not supported (only stored and deflate are)`);
}

// A ZIP opened once, with its members read on demand and cached. Every
// container format below (DOCX/PPTX/XLSX/ODF/EPUB) is a ZIP with a known
// layout, so they all share this.
async function openZip(buf) {
  const entries = readZipDirectory(buf);
  const byName = new Map(entries.map(e => [e.name, e]));
  const cache = new Map();
  const bytes = async (name) => {
    if (cache.has(name)) return cache.get(name);
    const e = byName.get(name);
    if (!e) return null;
    const b = await readZipEntry(buf, e);
    cache.set(name, b);
    return b;
  };
  const text = async (name) => {
    const b = await bytes(name);
    if (!b) return null;
    const d = decodeText(b);
    return d ? d.text : null;
  };
  return { entries, byName, bytes, text, has: (n) => byName.has(n) };
}

// ── TAR ─────────────────────────────────────────────────────────────────────
// 512-byte headers, octal sizes, members padded to 512. Old, simple, and the
// only thing standing between a .tar.gz and being an unreadable blob.
function readTar(bytes) {
  const entries = [];
  const dec = new TextDecoder('utf-8');
  const str = (off, len) => {
    const raw = bytes.subarray(off, off + len);
    let end = raw.indexOf(0);
    return dec.decode(end < 0 ? raw : raw.subarray(0, end)).trim();
  };
  let p = 0;
  while (p + 512 <= bytes.length && entries.length < MAX_ARCHIVE_ENTRIES) {
    const name = str(p, 100);
    if (!name) break; // two zero blocks end the archive
    const size = parseInt(str(p + 124, 12) || '0', 8) || 0;
    const typeflag = String.fromCharCode(bytes[p + 156] || 0x30);
    const prefix = str(p + 345, 155);
    const full = prefix ? `${prefix}/${name}` : name;
    const dataStart = p + 512;
    entries.push({
      name: full, size, dir: typeflag === '5' || full.endsWith('/'),
      read: () => bytes.subarray(dataStart, dataStart + size),
    });
    p = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

// ── XML → text ──────────────────────────────────────────────────────────────
// DOMParser does the parsing (entities, namespaces, CDATA — all the things a
// regex over markup gets wrong). What varies between formats is only which
// element names mean "paragraph", "line break" and "tab", so that is the only
// thing these callers configure.
function parseXml(xml, mime = 'application/xml') {
  const doc = new DOMParser().parseFromString(xml, mime);
  if (doc.getElementsByTagName('parsererror').length) return null;
  return doc;
}

// `cell` is what makes a table come out as a table. Without it a DOCX row of
// three cells — each of which is a <w:p> in the markup — renders as three
// separate paragraphs, and the row that said "Berth 9 | 3.4m" arrives in the
// index as three unrelated lines. Inside a cell, paragraph breaks become
// spaces and the cell itself ends with a tab, so a row stays a row.
function xmlToText(root, rules) {
  const block = rules.block || new Set();
  const brk = rules.brk || new Set();
  const tab = rules.tab || new Set();
  const cell = rules.cell || new Set();
  const skip = rules.skip || new Set();
  const out = [];
  const walk = (node, inCell) => {
    if (node.nodeType === 3) { out.push(node.nodeValue); return; }
    if (node.nodeType !== 1) return;
    const ln = (node.localName || node.nodeName || '').toLowerCase();
    if (skip.has(ln)) return;
    if (brk.has(ln)) { out.push(inCell ? ' ' : '\n'); return; }
    if (tab.has(ln)) { out.push('\t'); return; }
    const isCell = cell.has(ln);
    for (let c = node.firstChild; c; c = c.nextSibling) walk(c, inCell || isCell);
    if (isCell) out.push('\t');
    else if (block.has(ln)) out.push(inCell ? ' ' : '\n');
  };
  walk(root, false);
  return out.join('')
    .replace(/ +\t/g, '\t')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\t+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Office Open XML ─────────────────────────────────────────────────────────
async function extractDocx(zip, onProgress) {
  // The body, then footnotes and endnotes — all three are text the author
  // wrote, and leaving the notes out silently loses content the reader can
  // see in Word. Headers and footers are deliberately excluded: they repeat
  // per page and would show up in search as dozens of identical passages.
  const parts = [
    { path: 'word/document.xml', label: null },
    { path: 'word/footnotes.xml', label: 'Footnotes' },
    { path: 'word/endnotes.xml', label: 'Endnotes' },
  ];
  const rules = {
    block: new Set(['p', 'tr']),
    brk: new Set(['br', 'cr']),
    tab: new Set(['tab']),
    cell: new Set(['tc']),
    skip: new Set(['instrtext', 'delete', 'prooferr', 'bookmarkstart', 'bookmarkend']),
  };
  const sections = [];
  for (const part of parts) {
    if (!zip.has(part.path)) continue;
    onProgress && onProgress(`reading ${part.path}`);
    const xml = await zip.text(part.path);
    if (!xml) continue;
    const doc = parseXml(xml);
    if (!doc) continue;
    const text = xmlToText(doc.documentElement, rules);
    if (!text.trim()) continue;
    sections.push(part.label ? `--- ${part.label} ---\n\n${text}` : text);
  }
  if (!sections.length) return { gap: 'the DOCX has no word/document.xml body text' };
  return { text: sections.join('\n\n'), method: 'docx/openxml' };
}

async function extractPptx(zip, onProgress) {
  const slideRe = /^ppt\/slides\/slide(\d+)\.xml$/;
  const notesRe = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/;
  const slides = zip.entries
    .map(e => ({ e, m: slideRe.exec(e.name) }))
    .filter(x => x.m)
    .map(x => ({ name: x.e.name, n: parseInt(x.m[1], 10) }))
    .sort((a, b) => a.n - b.n);
  if (!slides.length) return { gap: 'the PPTX has no ppt/slides/slideN.xml parts' };

  const notesByN = new Map(zip.entries
    .map(e => ({ e, m: notesRe.exec(e.name) }))
    .filter(x => x.m)
    .map(x => [parseInt(x.m[1], 10), x.e.name]));

  const rules = { block: new Set(['p']), brk: new Set(['br']), skip: new Set([]) };
  const out = [];
  for (const s of slides) {
    onProgress && onProgress(`slide ${s.n} of ${slides.length}`);
    const xml = await zip.text(s.name);
    const doc = xml && parseXml(xml);
    const body = doc ? xmlToText(doc.documentElement, rules) : '';
    let block = `--- Slide ${s.n} ---\n\n${body}`;
    const notesPath = notesByN.get(s.n);
    if (notesPath) {
      const nxml = await zip.text(notesPath);
      const ndoc = nxml && parseXml(nxml);
      const notes = ndoc ? xmlToText(ndoc.documentElement, rules) : '';
      // Notes repeat the slide body in the OOXML notes part; only add what is
      // actually additional, so speaker notes don't double every slide.
      const extra = notes.split('\n').filter(l => l.trim() && !body.includes(l.trim())).join('\n');
      if (extra.trim()) block += `\n\nNotes:\n${extra.trim()}`;
    }
    out.push(block);
  }
  return { text: out.join('\n\n'), method: 'pptx/openxml', meta: { slides: slides.length } };
}

// XLSX without SheetJS. index.html prefers SheetJS (it handles .xls, formulas
// and formatting); this exists so that an offline tab, or one whose CDN is
// blocked, still reads a spreadsheet instead of reporting a gap for a format
// that is right there in a ZIP we can already open.
function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

async function extractXlsx(zip, onProgress) {
  const sharedXml = await zip.text('xl/sharedStrings.xml');
  const shared = [];
  if (sharedXml) {
    const doc = parseXml(sharedXml);
    if (doc) {
      for (const si of doc.getElementsByTagName('si')) {
        let s = '';
        for (const t of si.getElementsByTagName('t')) s += t.textContent;
        shared.push(s);
      }
    }
  }
  const sheetPaths = zip.entries
    .filter(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!sheetPaths.length) return { gap: 'the workbook has no xl/worksheets parts' };

  // Sheet names live in workbook.xml in the same document order as the
  // worksheet parts for every writer in practice; using them makes the reader
  // say "Q3 Actuals" instead of "sheet1.xml".
  const wbXml = await zip.text('xl/workbook.xml');
  const wbDoc = wbXml && parseXml(wbXml);
  const names = wbDoc ? [...wbDoc.getElementsByTagName('sheet')].map(s => s.getAttribute('name')) : [];

  const csvOf = (doc) => {
    const rows = [];
    for (const row of doc.getElementsByTagName('row')) {
      const cells = [];
      for (const c of row.getElementsByTagName('c')) {
        const idx = colIndex(c.getAttribute('r'));
        const type = c.getAttribute('t');
        let val = '';
        if (type === 's') {
          const v = c.getElementsByTagName('v')[0];
          val = v ? (shared[parseInt(v.textContent, 10)] ?? '') : '';
        } else if (type === 'inlineStr') {
          for (const t of c.getElementsByTagName('t')) val += t.textContent;
        } else {
          const v = c.getElementsByTagName('v')[0];
          val = v ? v.textContent : '';
        }
        while (cells.length < idx) cells.push('');
        cells[idx] = /[",\n]/.test(val) ? `"${val.replace(/"/g, '""')}"` : val;
      }
      rows.push(cells.join(','));
    }
    return rows.join('\n');
  };

  const sheets = [];
  for (let i = 0; i < sheetPaths.length; i++) {
    onProgress && onProgress(`sheet ${i + 1} of ${sheetPaths.length}`);
    const xml = await zip.text(sheetPaths[i].name);
    const doc = xml && parseXml(xml);
    if (!doc) continue;
    sheets.push({ name: names[i] || `Sheet${i + 1}`, csv: csvOf(doc) });
  }
  if (!sheets.length) return { gap: 'no worksheet in the workbook could be parsed' };
  // The reader's grid renders one delimited table, so the first sheet is the
  // body and the rest are appended with a labelled break — present and
  // searchable, and visibly not part of the first sheet's grid.
  const text = sheets.length === 1
    ? sheets[0].csv
    : sheets.map((s, i) => (i === 0 ? s.csv : `\n--- Sheet: ${s.name} ---\n${s.csv}`)).join('\n');
  return { text, method: 'xlsx/openxml', meta: { sheets: sheets.length, sheetNames: sheets.map(s => s.name) } };
}

// ── OpenDocument ────────────────────────────────────────────────────────────
async function extractOdf(zip, kind, onProgress) {
  onProgress && onProgress('reading content.xml');
  const xml = await zip.text('content.xml');
  if (!xml) return { gap: 'the OpenDocument package has no content.xml' };
  const doc = parseXml(xml);
  if (!doc) return { gap: 'content.xml is not well-formed XML' };
  const body = doc.getElementsByTagName('office:body')[0] || doc.documentElement;

  if (kind === 'spreadsheet') {
    // ODS cells carry repeat counts; expanding them is what makes column
    // positions line up with the header row instead of drifting left.
    const rows = [];
    for (const row of body.getElementsByTagName('table:table-row')) {
      const cells = [];
      for (const cell of row.children) {
        const rep = Math.min(parseInt(cell.getAttribute('table:number-columns-repeated') || '1', 10) || 1, 1024);
        const val = (cell.textContent || '').trim();
        for (let i = 0; i < rep; i++) cells.push(/[",\n]/.test(val) ? `"${val.replace(/"/g, '""')}"` : val);
      }
      while (cells.length && cells[cells.length - 1] === '') cells.pop();
      rows.push(cells.join(','));
    }
    while (rows.length && !rows[rows.length - 1]) rows.pop();
    return { text: rows.join('\n'), method: 'ods/opendocument' };
  }

  const text = xmlToText(body, {
    block: new Set(['p', 'h', 'table-row', 'list-item']),
    brk: new Set(['line-break']),
    tab: new Set(['tab']),
    cell: new Set(['table-cell']),
  });
  return { text, method: `${kind === 'presentation' ? 'odp' : 'odt'}/opendocument` };
}

// ── EPUB ────────────────────────────────────────────────────────────────────
async function extractEpub(zip, onProgress) {
  const container = await zip.text('META-INF/container.xml');
  if (!container) return { gap: 'the EPUB has no META-INF/container.xml' };
  const cdoc = parseXml(container);
  const rootfile = cdoc && cdoc.getElementsByTagName('rootfile')[0];
  const opfPath = rootfile && rootfile.getAttribute('full-path');
  if (!opfPath) return { gap: 'the EPUB container names no OPF rootfile' };

  const opfXml = await zip.text(opfPath);
  const opf = opfXml && parseXml(opfXml);
  if (!opf) return { gap: `the EPUB's ${opfPath} could not be parsed` };

  const dir = opfPath.includes('/') ? opfPath.replace(/\/[^/]*$/, '/') : '';
  const manifest = new Map();
  for (const item of opf.getElementsByTagName('item')) {
    manifest.set(item.getAttribute('id'), {
      href: item.getAttribute('href'),
      type: item.getAttribute('media-type') || '',
    });
  }
  // Spine order is the book's reading order — the difference between a book
  // and a pile of chapters in whatever order the ZIP happened to store them.
  const spine = [...opf.getElementsByTagName('itemref')]
    .map(r => manifest.get(r.getAttribute('idref')))
    .filter(it => it && /xhtml|html/.test(it.type));
  if (!spine.length) return { gap: 'the EPUB spine lists no XHTML documents' };

  const titleEl = opf.getElementsByTagName('dc:title')[0] || opf.getElementsByTagName('title')[0];
  const bookTitle = titleEl ? titleEl.textContent.trim() : '';

  const resolve = (href) => {
    const raw = decodeURIComponent(String(href).split('#')[0]);
    if (zip.has(raw)) return raw;
    const joined = (dir + raw).replace(/\/\.\//g, '/');
    if (zip.has(joined)) return joined;
    // Last resort: match on basename. EPUBs in the wild carry relative hrefs
    // that don't normalise cleanly; the alternative to this is losing chapters.
    const base = raw.replace(/^.*\//, '');
    const hit = zip.entries.find(e => e.name.endsWith('/' + base) || e.name === base);
    return hit ? hit.name : null;
  };

  const chunks = [];
  let n = 0;
  for (const item of spine) {
    n++;
    onProgress && onProgress(`chapter ${n} of ${spine.length}`);
    const path = resolve(item.href);
    if (!path) continue;
    const html = await zip.text(path);
    if (!html) continue;
    const text = htmlToText(html);
    if (text.trim()) chunks.push(text);
  }
  if (!chunks.length) return { gap: 'no chapter in the EPUB spine yielded text' };
  const head = bookTitle ? `${bookTitle}\n\n` : '';
  return { text: head + chunks.join('\n\n'), method: 'epub/spine', meta: { chapters: chunks.length, title: bookTitle } };
}

// HTML → text. Used for EPUB chapters and for .html uploads whose markup would
// otherwise be indexed as if the tags were prose.
function htmlToText(html) {
  const doc = parseXml(html, 'application/xhtml+xml') || new DOMParser().parseFromString(html, 'text/html');
  const root = doc.body || doc.documentElement;
  if (!root) return '';
  return xmlToText(root, {
    block: new Set(['p', 'div', 'section', 'article', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'figcaption']),
    brk: new Set(['br', 'hr']),
    cell: new Set(['td', 'th']),
    skip: new Set(['script', 'style', 'noscript', 'svg', 'head']),
  });
}

// ── RTF ─────────────────────────────────────────────────────────────────────
// RTF is text with control words, so this is a real parse rather than a guess:
// groups nest, \'hh is a code-page byte, \uN is a Unicode codepoint with a
// skip-count, and destinations opened with \* carry data no reader displays.
function extractRtf(src) {
  let out = '';
  let i = 0;
  const skipStack = [];
  let skipping = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '{') { skipStack.push(skipping); i++; continue; }
    if (ch === '}') { skipping = skipStack.pop() || 0; i++; continue; }
    if (ch === '\\') {
      const esc = src[i + 1];
      if (esc === '\\' || esc === '{' || esc === '}') { if (!skipping) out += esc; i += 2; continue; }
      if (esc === '*') { skipping = 1; i += 2; continue; }
      if (esc === "'") { const hex = src.substr(i + 2, 2); if (!skipping) out += String.fromCharCode(parseInt(hex, 16) || 0); i += 4; continue; }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i));
      if (!m) { i++; continue; }
      const word = m[1], arg = m[2] != null ? parseInt(m[2], 10) : null;
      if (word === 'par' || word === 'line' || word === 'sect') { if (!skipping) out += '\n'; }
      else if (word === 'tab') { if (!skipping) out += '\t'; }
      else if (word === 'u' && arg != null) { if (!skipping) out += String.fromCharCode(arg < 0 ? arg + 65536 : arg); i += m[0].length + 1; continue; }
      else if (['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'themedata', 'datastore', 'listtable', 'rsidtbl', 'generator'].includes(word)) skipping = 1;
      i += m[0].length;
      continue;
    }
    if (ch === '\r' || ch === '\n') { i++; continue; }
    if (!skipping) out += ch;
    i++;
  }
  const text = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text ? { text, method: 'rtf' } : { gap: 'the RTF contained no readable text runs' };
}

// ── Jupyter notebooks ───────────────────────────────────────────────────────
// A .ipynb is JSON, so it would already ingest as "text" — but as raw JSON,
// where every prose sentence is wrapped in quotes and comma-separated and no
// search over it reads like the notebook. This renders it the way it reads.
function extractNotebook(json) {
  let nb;
  try { nb = JSON.parse(json); } catch (e) { return { gap: `the notebook is not valid JSON — ${e.message}` }; }
  const cells = Array.isArray(nb.cells) ? nb.cells : [];
  if (!cells.length) return { gap: 'the notebook has no cells' };
  const lang = (nb.metadata && nb.metadata.kernelspec && nb.metadata.kernelspec.language) || 'python';
  const src = (c) => Array.isArray(c.source) ? c.source.join('') : String(c.source || '');
  const out = [];
  let n = 0;
  for (const c of cells) {
    n++;
    if (c.cell_type === 'markdown') out.push(src(c).trim());
    else if (c.cell_type === 'code') {
      out.push(`--- In [${c.execution_count ?? ' '}] (${lang}) ---\n\n${src(c).trim()}`);
      // Outputs are part of what the notebook says. Text outputs are included;
      // images and other binary payloads are named, not decoded.
      for (const o of (c.outputs || [])) {
        const t = o.text ? (Array.isArray(o.text) ? o.text.join('') : o.text)
          : (o.data && o.data['text/plain']) ? (Array.isArray(o.data['text/plain']) ? o.data['text/plain'].join('') : o.data['text/plain'])
            : o.ename ? `${o.ename}: ${o.evalue}` : '';
        if (t && String(t).trim()) out.push(`Out:\n${String(t).trim()}`);
        else if (o.data && Object.keys(o.data).some(k => k.startsWith('image/'))) out.push('Out: [image output — not decoded]');
      }
    } else if (c.cell_type === 'raw') out.push(src(c).trim());
  }
  return { text: out.filter(Boolean).join('\n\n'), method: 'ipynb/cells', meta: { cells: n } };
}

// ── Archives ────────────────────────────────────────────────────────────────
// An archive's own content IS its listing — that is what the reader wants to
// see first. Text members are additionally pulled out and ingested (capped),
// because a repo tarball or a bundle of transcripts is a real corpus and
// refusing to read it because it arrived zipped would be an arbitrary line.
async function extractZipArchive(zip, onProgress) {
  const files = zip.entries.filter(e => !e.dir);
  const listing = archiveListing(files.map(e => ({ name: e.name, size: e.size, compressedSize: e.compressedSize })));
  const parts = [listing];
  let budget = MAX_ARCHIVE_TEXT;
  let read = 0, failed = 0;
  for (const e of files) {
    if (budget <= 0) break;
    if (e.size > MAX_ARCHIVE_MEMBER || e.size === 0) continue;
    if (!looksTextish(e.name)) continue;
    onProgress && onProgress(`reading ${e.name}`);
    try {
      const b = await zip.bytes(e.name);
      const d = b && decodeText(b);
      if (!d || !d.text.trim()) continue;
      const body = d.text.slice(0, budget);
      budget -= body.length;
      read++;
      parts.push(`--- ${e.name} ---\n\n${body}`);
    } catch { failed++; }
  }
  const note = failed ? `${failed} member(s) could not be decompressed in this browser` : null;
  return {
    text: parts.join('\n\n'), method: 'zip/listing+members',
    entries: files.map(e => ({ name: e.name, size: e.size, compressedSize: e.compressedSize })),
    meta: { members: files.length, textMembersRead: read }, note,
  };
}

function archiveListing(entries) {
  const rows = entries.slice(0, MAX_ARCHIVE_ENTRIES)
    .map(e => `${formatBytes(e.size).padStart(10)}  ${e.name}`);
  const more = entries.length > MAX_ARCHIVE_ENTRIES ? `\n… and ${entries.length - MAX_ARCHIVE_ENTRIES} more entries` : '';
  const total = entries.reduce((s, e) => s + (e.size || 0), 0);
  return `--- Archive contents: ${entries.length} file(s), ${formatBytes(total)} uncompressed ---\n\n${rows.join('\n')}${more}`;
}

// Which members of an archive are worth trying to read as text. Deciding by
// extension here (rather than by decoding everything) is what keeps a 500-file
// tarball from costing 500 inflate calls to discover it is all PNGs.
function looksTextish(name) {
  const k = EXT_KIND[extOf(name)] || BARE_NAME_KIND[stemOf(name)];
  if (k) return TEXT_SHAPED.has(k) && k !== 'pdf';
  return !/\./.test(baseOf(name)); // extensionless files in archives are usually scripts/config
}

async function extractTarArchive(bytes, onProgress, label = 'tar') {
  const entries = readTar(bytes).filter(e => !e.dir);
  if (!entries.length) return { gap: 'the TAR archive has no readable member headers' };
  const parts = [archiveListing(entries)];
  let budget = MAX_ARCHIVE_TEXT, read = 0;
  for (const e of entries) {
    if (budget <= 0) break;
    if (e.size > MAX_ARCHIVE_MEMBER || e.size === 0 || !looksTextish(e.name)) continue;
    onProgress && onProgress(`reading ${e.name}`);
    const d = decodeText(e.read());
    if (!d || !d.text.trim()) continue;
    const body = d.text.slice(0, budget);
    budget -= body.length;
    read++;
    parts.push(`--- ${e.name} ---\n\n${body}`);
  }
  return {
    text: parts.join('\n\n'), method: `${label}/listing+members`,
    entries: entries.map(e => ({ name: e.name, size: e.size })),
    meta: { members: entries.length, textMembersRead: read },
  };
}

// ── Email ───────────────────────────────────────────────────────────────────
// RFC 5322 far enough to be useful: unfold headers, show the ones a reader
// cares about, then the body — decoded when it is base64 or quoted-printable,
// and for multipart, the text/plain part rather than the HTML twin of it.
function extractEmail(raw) {
  const sepIdx = raw.search(/\r?\n\r?\n/);
  if (sepIdx < 0) return { text: raw, method: 'eml/raw' };
  const headerBlock = raw.slice(0, sepIdx).replace(/\r?\n[ \t]+/g, ' ');
  let body = raw.slice(sepIdx).replace(/^\r?\n\r?\n/, '');
  const headers = new Map();
  for (const line of headerBlock.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (m) headers.set(m[1].toLowerCase(), m[2]);
  }
  const ctype = headers.get('content-type') || '';
  const boundary = /boundary="?([^";]+)"?/i.exec(ctype);
  if (boundary) {
    const parts = body.split(new RegExp(`--${boundary[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const plain = parts.find(p => /content-type:\s*text\/plain/i.test(p));
    const html = parts.find(p => /content-type:\s*text\/html/i.test(p));
    const chosen = plain || html;
    if (chosen) {
      const bi = chosen.search(/\r?\n\r?\n/);
      let pb = bi >= 0 ? chosen.slice(bi).replace(/^\r?\n\r?\n/, '') : chosen;
      pb = decodeTransfer(pb, chosen);
      body = (chosen === html && !plain) ? htmlToText(pb) : pb;
    }
  } else {
    body = decodeTransfer(body, headerBlock);
    if (/text\/html/i.test(ctype)) body = htmlToText(body);
  }
  const shown = ['date', 'from', 'to', 'cc', 'subject']
    .filter(h => headers.has(h))
    .map(h => `${h[0].toUpperCase()}${h.slice(1)}: ${headers.get(h)}`);
  return { text: `${shown.join('\n')}\n\n${body.trim()}`, method: 'eml/rfc5322', meta: { subject: headers.get('subject') || '' } };
}

// Both base64 and quoted-printable produce BYTES, not characters, and the part
// header says which charset those bytes are in. Skipping that second step is
// how "3.4 metres" (a UTF-8 non-breaking space, =C2=A0) arrives as "3.4Â
// metres" — mojibake produced by treating decoded bytes as if they were
// already text. The charset declared on the part is honoured here.
function decodeTransfer(body, partHeaders) {
  const encMatch = /content-transfer-encoding:\s*([^\s;]+)/i.exec(partHeaders || '');
  const enc = encMatch ? encMatch[1].toLowerCase() : '';
  const csMatch = /charset="?([A-Za-z0-9_-]+)"?/i.exec(partHeaders || '');
  const charset = csMatch ? csMatch[1].toLowerCase() : 'utf-8';
  const fromBytes = (u8) => {
    const r = tryDecoder(u8, charset, charset) || decodeText(u8);
    return r ? r.text : null;
  };
  try {
    if (enc === 'base64') {
      const u8 = Uint8Array.from(atob(body.replace(/\s+/g, '')), c => c.charCodeAt(0));
      return fromBytes(u8) ?? body;
    }
    if (enc === 'quoted-printable') {
      const soft = body.replace(/=\r?\n/g, '');
      const u8 = [];
      for (let i = 0; i < soft.length; i++) {
        const m = soft[i] === '=' && /^=([0-9A-Fa-f]{2})/.exec(soft.slice(i, i + 3));
        if (m) { u8.push(parseInt(m[1], 16)); i += 2; }
        else u8.push(soft.charCodeAt(i) & 0xFF);
      }
      return fromBytes(new Uint8Array(u8)) ?? soft;
    }
  } catch { /* fall through to the raw body — never worse than not trying */ }
  return body;
}

// ── SVG ─────────────────────────────────────────────────────────────────────
// An SVG is both a picture and a document. The reader shows the picture; what
// gets indexed is the words in it (title, desc, <text>), not the path data —
// indexing "M 12.4 88.1 C …" would put thousands of meaningless tokens into a
// corpus whose whole promise is that a citation leads somewhere.
function extractSvg(src) {
  const doc = parseXml(src) || new DOMParser().parseFromString(src, 'text/html');
  if (!doc) return { gap: 'the SVG is not well-formed XML' };
  const bits = [];
  for (const tag of ['title', 'desc', 'text', 'tspan']) {
    for (const el of doc.getElementsByTagName(tag)) {
      const t = (el.textContent || '').trim();
      if (t) bits.push(t);
    }
  }
  const uniq = [...new Set(bits)];
  if (!uniq.length) return { gap: 'the SVG contains no <title>, <desc> or <text> — nothing to index (it still displays)' };
  return { text: uniq.join('\n'), method: 'svg/text-nodes' };
}

// ── Identification ──────────────────────────────────────────────────────────
// Bytes first, name second. A .txt that is actually a ZIP is a ZIP; a file
// called `notes` with no extension whose bytes decode as UTF-8 is text. Where
// the two disagree the disagreement is reported, not hidden, so a reader who
// wonders why their ".csv" opened as a hex dump gets told why.
function identifyBytes(bytes) {
  for (const sig of SIGNATURES) {
    if (bytesMatch(bytes, sig.off, sig.hex)) {
      // RIFF and ISO-BMFF are container families whose real type is a second
      // tag a few bytes in; reporting the family alone would be less than we
      // actually know.
      if (sig.id === 'riff') {
        const tag = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
        if (tag === 'WAVE') return { id: 'wav', label: 'WAV audio', kind: 'audio', mime: 'audio/wav' };
        if (tag === 'AVI ') return { id: 'avi', label: 'AVI video', kind: 'video', mime: 'video/x-msvideo' };
        if (tag === 'WEBP') return { id: 'webp', label: 'WebP image', kind: 'image', mime: 'image/webp' };
        return sig;
      }
      if (sig.id === 'isobmff') {
        const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
        if (/^hei|^mif1|^msf1/.test(brand)) return { id: 'heic', label: 'HEIF/HEIC image', kind: 'image', mime: 'image/heic' };
        if (/^avif|^avis/.test(brand)) return { id: 'avif', label: 'AVIF image', kind: 'image', mime: 'image/avif' };
        if (/^qt/.test(brand)) return { id: 'mov', label: 'QuickTime movie', kind: 'video', mime: 'video/quicktime' };
        if (/^M4A/.test(brand)) return { id: 'm4a', label: 'M4A audio', kind: 'audio', mime: 'audio/mp4' };
        return sig;
      }
      return sig;
    }
  }
  return null;
}

// A ZIP is never "a ZIP" when its layout says otherwise — DOCX, XLSX, PPTX,
// ODT, ODS, ODP, EPUB and JAR are all ZIPs, and treating them as archives
// would show a listing of XML parts where a document belongs. The mimetype
// entry and the well-known part paths are the evidence.
function zipSubtype(entries) {
  const names = new Set(entries.map(e => e.name));
  if (names.has('word/document.xml')) return { id: 'docx', label: 'Word document (OOXML)', kind: 'document' };
  if ([...names].some(n => n.startsWith('ppt/slides/slide'))) return { id: 'pptx', label: 'PowerPoint presentation (OOXML)', kind: 'presentation' };
  if (names.has('xl/workbook.xml')) return { id: 'xlsx', label: 'Excel workbook (OOXML)', kind: 'spreadsheet' };
  if (names.has('META-INF/container.xml') && [...names].some(n => /\.opf$/.test(n))) return { id: 'epub', label: 'EPUB book', kind: 'ebook' };
  if (names.has('mimetype')) {
    // ODF declares itself in a stored (uncompressed) `mimetype` member; the
    // part paths below are the same declaration read structurally.
    if (names.has('content.xml') && names.has('styles.xml')) {
      if ([...names].some(n => n.includes('Configurations2/'))) { /* fall through to content sniff */ }
      return { id: 'odf', label: 'OpenDocument', kind: 'document' };
    }
  }
  if ([...names].some(n => n.startsWith('META-INF/') && n.endsWith('.MF'))) return { id: 'jar', label: 'Java archive', kind: 'archive' };
  return null;
}

/**
 * What is this file? Extension and magic bytes, reconciled.
 * `head` is optional — pass the first bytes to get a byte-level answer.
 */
function identify(name, head) {
  const ext = extOf(name);
  const byExt = EXT_KIND[ext] || BARE_NAME_KIND[stemOf(name)] || null;
  const byBytes = head && head.length ? identifyBytes(head) : null;

  // Bytes win on kind whenever they say anything, EXCEPT where the extension
  // is strictly more specific about the same bytes (a .docx and a .jar are
  // both "zip" to a signature table).
  let kind = byBytes ? byBytes.kind : (byExt || null);
  if (byBytes && byBytes.id === 'zip' && byExt) kind = byExt;
  if (byBytes && byBytes.id === 'ole2' && byExt) kind = byExt;
  if (!kind) kind = null;

  const conflict = !!(byBytes && byExt && byBytes.kind !== byExt
    && !['gzip', 'ole2'].includes(byBytes.id)
    && !(byBytes.id === 'zip' && ['document', 'presentation', 'spreadsheet', 'ebook', 'archive'].includes(byExt))
    && !(byExt === 'code' && byBytes.kind === 'text'));

  const fallbackLabel = ext
    ? `.${ext} ${(KIND_LABEL[byExt] || 'file').toLowerCase()}`
    : (KIND_LABEL[byExt] || 'file with no extension');

  return {
    name: baseOf(name),
    ext,
    kind,
    format: byBytes ? byBytes.id : (ext || stemOf(name) || null),
    label: byBytes ? byBytes.label : fallbackLabel,
    mime: byBytes ? byBytes.mime : null,
    fromBytes: !!byBytes,
    conflict,
    conflictNote: conflict
      ? `named .${ext}, but the bytes are ${byBytes.label} — read as ${byBytes.label}, not as ${KIND_LABEL[byExt] || byExt}`
      : null,
  };
}

/** The reader's display bucket for a name, with no bytes to hand. */
function kindOf(name) {
  const n = String(name || '');
  if (n.startsWith('prior:')) return 'text';
  if (/^https?:/i.test(n)) return 'link';
  return EXT_KIND[extOf(n)] || BARE_NAME_KIND[stemOf(n)] || 'binary';
}

// ── The entry point ─────────────────────────────────────────────────────────
/**
 * Read a File as far as this app honestly can.
 *
 * Always resolves — a format with no parser is a RESULT (`gap` set, plus the
 * hex and strings surfaces the reader displays), never a rejection, because
 * "we cannot index this" and "something broke" are different things and the
 * reader has to be able to tell them apart.
 *
 * Returns:
 *   { kind, format, label, method, text, gap, note, entries, meta,
 *     hex, strings, encoding, bytes, size, displayable }
 *   - text: what gets ingested (empty string when nothing is indexable)
 *   - gap: why nothing was indexed, in the reader's words
 *   - displayable: this file's own bytes are worth showing (image/av/binary)
 */
async function extract(file, opts = {}) {
  const onProgress = opts.onProgress || null;
  const name = file.name || 'file';
  const size = file.size;

  const headBuf = await file.slice(0, Math.min(MAX_SNIFF, size)).arrayBuffer();
  const head = new Uint8Array(headBuf);
  const id = identify(name, head);
  const base = {
    name, size, kind: id.kind || 'binary', format: id.format, label: id.label,
    mime: id.mime, conflictNote: id.conflictNote, text: '', gap: null, note: null,
    method: null, entries: null, meta: null, encoding: null, displayable: false,
  };

  try {
    // Media and fonts: the bytes are the content. Nothing to extract; the
    // reader plays or draws them. (Images additionally go through the Senses
    // pipeline in index.html — that is a separate, model-tier capability.)
    if (base.kind === 'video' || base.kind === 'audio') {
      return { ...base, displayable: true, gap: `no ${base.kind} perceiver runs here — the file plays, nothing is transcribed` };
    }
    if (base.kind === 'font') {
      const full = new Uint8Array(await file.arrayBuffer());
      return { ...base, displayable: true, ...binarySurfaces(full), gap: 'a font has no text layer to index — its glyph table is shape data, not prose' };
    }

    // SVG is text on the wire and a picture on screen.
    if (id.format === 'svg' || (extOf(name) === 'svg')) {
      const full = new Uint8Array(await file.arrayBuffer());
      const d = decodeText(full);
      if (!d) return { ...base, kind: 'image', displayable: true, ...binarySurfaces(full), gap: 'the .svg did not decode as text' };
      const r = extractSvg(d.text);
      return { ...base, kind: 'image', displayable: true, encoding: d.encoding, ...r };
    }

    if (base.kind === 'image') {
      const full = new Uint8Array(await file.arrayBuffer());
      return { ...base, displayable: true, ...binarySurfaces(full) };
    }

    if (base.kind === 'pdf') {
      // PDF.js lives in index.html (it also renders pages and drives OCR);
      // this module only says what the file is, so that path stays one path.
      return { ...base, displayable: true, method: 'delegated:pdfjs' };
    }

    // ── Container formats ────────────────────────────────────────────────
    const isZip = id.format === 'zip' || bytesMatch(head, 0, '504b0304');
    if (isZip) {
      onProgress && onProgress('opening container');
      const buf = await file.arrayBuffer();
      let zip;
      try { zip = await openZip(buf); }
      catch (e) {
        const full = new Uint8Array(buf);
        return { ...base, kind: 'archive', displayable: true, ...binarySurfaces(full), gap: `ZIP directory unreadable — ${e.message}` };
      }
      // What a ZIP really is comes from its own layout — the parts it
      // contains and, for OpenDocument, the `mimetype` member it is required
      // to store first and uncompressed. The extension is only consulted
      // where the layout is silent.
      const sub = zipSubtype(zip.entries) || {};
      const ext = extOf(name);
      const odfMime = zip.has('mimetype') ? (await zip.text('mimetype') || '').trim() : '';
      const flavour = sub.id
        || (['docx', 'docm', 'dotx'].includes(ext) ? 'docx'
          : ['pptx', 'pptm', 'ppsx', 'potx'].includes(ext) ? 'pptx'
            : ['xlsx', 'xlsm'].includes(ext) ? 'xlsx'
              : ['odt', 'ott', 'ods', 'odp'].includes(ext) ? 'odf'
                : ext === 'epub' ? 'epub' : 'zip');
      const withSub = { ...base, label: sub.label || base.label, kind: sub.kind || base.kind, format: sub.id || flavour };
      let r;
      if (flavour === 'docx') r = await extractDocx(zip, onProgress);
      else if (flavour === 'pptx') r = await extractPptx(zip, onProgress);
      else if (flavour === 'xlsx') r = await extractXlsx(zip, onProgress);
      else if (flavour === 'epub') r = await extractEpub(zip, onProgress);
      else if (flavour === 'odf') {
        const odfKind = /spreadsheet/.test(odfMime) || ext === 'ods' ? 'spreadsheet'
          : /presentation/.test(odfMime) || ext === 'odp' ? 'presentation'
            : 'document';
        r = await extractOdf(zip, odfKind, onProgress);
        withSub.kind = odfKind;
        withSub.label = `OpenDocument ${KIND_LABEL[odfKind]}`;
        withSub.format = odfKind === 'spreadsheet' ? 'ods' : odfKind === 'presentation' ? 'odp' : 'odt';
      } else {
        r = await extractZipArchive(zip, onProgress);
        withSub.kind = 'archive';
        withSub.label = sub.label || 'ZIP archive';
      }
      // The extension lied about a container: say which one the bytes are.
      // A .txt that is really a ZIP opens as an archive, and the reader is
      // told why rather than being left to wonder.
      if (flavour !== 'zip' || withSub.kind === 'archive') {
        const expected = EXT_KIND[ext];
        if (expected && expected !== withSub.kind) {
          withSub.conflictNote = `named .${ext}, but the container is ${withSub.label} — read as that`;
        }
      }
      // A container we know the shape of but could not read is still a ZIP
      // underneath — show its parts rather than nothing at all.
      if (r.gap && flavour !== 'zip') {
        const fallback = await extractZipArchive(zip, onProgress).catch(() => null);
        if (fallback) return { ...withSub, ...fallback, kind: 'archive', note: r.gap, displayable: true };
      }
      return { ...withSub, ...r, displayable: withSub.kind === 'archive' };
    }

    if (id.format === 'gzip' || bytesMatch(head, 0, '1f8b')) {
      onProgress && onProgress('decompressing gzip');
      const raw = new Uint8Array(await file.arrayBuffer());
      let inner;
      try { inner = await gunzip(raw); }
      catch (e) { return { ...base, kind: 'archive', displayable: true, ...binarySurfaces(raw), gap: `gzip could not be decompressed — ${e.message}` }; }
      // .tar.gz is the common case; a gzipped single file is the other.
      if (bytesMatch(inner, 257, '7573746172') || /\.(tgz|tar\.gz)$/i.test(name)) {
        const r = await extractTarArchive(inner, onProgress, 'tar.gz');
        return { ...base, kind: 'archive', format: 'tar.gz', label: 'gzipped TAR archive', displayable: true, ...r };
      }
      const d = decodeText(inner);
      if (d) {
        // A gzipped log or dump: the inner name (minus .gz) is what it really
        // is, so a .json.gz reads as data and a .csv.gz as a spreadsheet.
        const innerKind = EXT_KIND[extOf(name.replace(/\.gz$/i, ''))] || 'text';
        return { ...base, kind: innerKind, format: 'gzip', text: d.text, encoding: d.encoding, method: 'gzip/text' };
      }
      return { ...base, kind: 'archive', displayable: true, ...binarySurfaces(inner), gap: 'the gzip stream decompressed to binary with no known format' };
    }

    if (id.format === 'tar' || /\.tar$/i.test(name)) {
      const raw = new Uint8Array(await file.arrayBuffer());
      const r = await extractTarArchive(raw, onProgress);
      return { ...base, kind: 'archive', displayable: true, ...r };
    }

    // Compressed formats with no decoder in the platform. Named, sized,
    // listed as unreadable — not silently swallowed.
    if (['bzip2', 'xz', 'zstd', '7z', 'rar', 'cab', 'ar', 'iso9660'].includes(id.format)) {
      const raw = new Uint8Array(await file.arrayBuffer());
      return {
        ...base, kind: 'archive', displayable: true, ...binarySurfaces(raw),
        gap: `${id.label} needs a decompressor this browser does not ship — re-archive as .zip or .tar.gz to read the contents`,
      };
    }

    if (id.format === 'ole2') {
      const raw = new Uint8Array(await file.arrayBuffer());
      return {
        ...base, displayable: true, ...binarySurfaces(raw),
        gap: 'legacy OLE2 Office (.doc/.xls/.ppt, pre-2007) has no parser here — its printable strings are shown below, unindexed, because a strings dump is not a document. Re-save as .docx/.xlsx/.pptx to index it.',
      };
    }

    if (id.format === 'rtf' || extOf(name) === 'rtf') {
      const raw = new Uint8Array(await file.arrayBuffer());
      const d = decodeText(raw);
      if (!d) return { ...base, displayable: true, ...binarySurfaces(raw), gap: 'the RTF did not decode as text' };
      return { ...base, encoding: d.encoding, ...extractRtf(d.text) };
    }

    // ── Text and text-derived formats ────────────────────────────────────
    if (size > MAX_TEXT_DECODE) {
      return { ...base, displayable: true, gap: `${formatBytes(size)} is past the ${formatBytes(MAX_TEXT_DECODE)} in-browser decode ceiling — split the file to ingest it` };
    }
    const raw = new Uint8Array(await file.arrayBuffer());
    const d = decodeText(raw);
    if (!d) {
      return {
        ...base, kind: base.kind === 'binary' ? 'binary' : base.kind, displayable: true,
        ...binarySurfaces(raw),
        gap: base.label
          ? `${base.label} has no text parser here — its bytes are shown below, unindexed`
          : 'these bytes are not text in any encoding this browser knows, and no parser matched their signature — shown below as hex and printable strings, unindexed',
      };
    }

    const ext = extOf(name);
    if (ext === 'ipynb') return { ...base, kind: 'notebook', encoding: d.encoding, ...extractNotebook(d.text) };
    if (ext === 'eml' || ext === 'mbox') return { ...base, kind: 'email', encoding: d.encoding, ...extractEmail(d.text) };
    if (['html', 'htm', 'xhtml'].includes(ext)) {
      const stripped = htmlToText(d.text);
      // Markup that yields nothing readable (an app shell, a redirect stub) is
      // reported rather than ingested as an empty document.
      if (stripped.trim().length > 20) return { ...base, kind: 'code', encoding: d.encoding, text: stripped, method: 'html/text' };
      return { ...base, kind: 'code', encoding: d.encoding, text: d.text, method: 'html/raw', note: 'no readable body text — the raw markup was indexed instead' };
    }

    // Plain text of any flavour, including every extension not in the table
    // above. This is the case that makes "virtually any file" true: if the
    // bytes decode, they are read, whatever the file is called.
    const kind = base.kind && base.kind !== 'binary' ? base.kind : (EXT_KIND[ext] || 'text');
    return {
      ...base, kind, text: d.text, encoding: d.encoding,
      method: `text/${d.encoding.toLowerCase().replace(/\s+/g, '-')}`,
      note: (!EXT_KIND[ext] && !BARE_NAME_KIND[stemOf(name)])
        ? `.${ext || '(no extension)'} is not a format this app knows by name — its bytes decoded as ${d.encoding}, so it was read as text`
        : null,
    };
  } catch (err) {
    // Any unexpected failure still returns a result: L1d — a path that dies
    // quietly is worse than one that fails loudly.
    return { ...base, gap: `could not be read — ${err.message}`, displayable: true };
  }
}

function binarySurfaces(bytes) {
  const hex = hexDump(bytes);
  const { strings, truncated } = printableStrings(bytes);
  return { hex, strings, stringsTruncated: truncated };
}

const EOFormats = {
  identify, kindOf, extract, decodeText, hexDump, printableStrings,
  htmlToText, formatBytes, openZip, readTar, gunzip,
  KIND_GLYPH, KIND_LABEL, TEXT_SHAPED, EXT_KIND,
  isTextShaped: (kind) => TEXT_SHAPED.has(kind),
  glyphFor: (kind) => KIND_GLYPH[kind] || '◱',
  labelFor: (kind) => KIND_LABEL[kind] || 'File',
};

if (typeof window !== 'undefined') window.EOFormats = EOFormats;
export default EOFormats;
export { identify, kindOf, extract, decodeText, hexDump, printableStrings, htmlToText, formatBytes };
