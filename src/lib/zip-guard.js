/*
 * An .xlsx is a zip. Before a workbook library unpacks one, read the zip's
 * own directory (at the end of the file) and refuse a file that says it would
 * unpack to far more than any real spreadsheet - a "zip bomb" built to
 * exhaust the server's memory - or that has an absurd number of parts.
 */
const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;

/** Throws `refuse(reason)`'s error unless the zip in `buffer` stays within the limits. */
export function checkZip(buffer, { maxEntries = 2_000, maxUnpackedBytes = 100 * 1024 * 1024, refuse = (reason) => new Error(reason) } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw refuse('not a zip');
  // The end record sits in the last 22 bytes, or before a comment of up to 64 KB.
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 0xFFFF); at -= 1) {
    if (buffer.readUInt32LE(at) === END_OF_DIRECTORY) { end = at; break; }
  }
  if (end < 0) throw refuse('not a zip');
  const entries = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryAt = buffer.readUInt32LE(end + 16);
  // ZIP64 (sizes too large for the classic fields) never comes from a spreadsheet this size.
  if (entries === 0xFFFF || directoryAt === 0xFFFFFFFF || directorySize === 0xFFFFFFFF) throw refuse('zip64');
  if (entries > maxEntries) throw refuse('too many parts');
  if (directoryAt + directorySize > buffer.length) throw refuse('truncated');
  let at = directoryAt;
  let unpacked = 0;
  for (let index = 0; index < entries; index += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== DIRECTORY_ENTRY) throw refuse('corrupt directory');
    const packed = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    if (packed === 0xFFFFFFFF || size === 0xFFFFFFFF) throw refuse('zip64');
    unpacked += size;
    if (unpacked > maxUnpackedBytes) throw refuse('too large unpacked');
    at += 46 + buffer.readUInt16LE(at + 28) + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return { entries, unpacked };
}
