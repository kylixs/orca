/**
 * Minimal TLS ClientHello parser: extracts the SNI server_name without
 * decrypting anything. The relay only needs the name to pick a route; the TLS
 * session itself stays end to end between client and host.
 */
export function extractSni(buffer: Buffer): string | null {
  if (buffer.length < 5) return null
  if (buffer[0] !== 0x16) return null // handshake record
  const recordLength = buffer.readUInt16BE(3)
  if (buffer.length < 5 + recordLength) return null
  let offset = 5
  if (buffer[offset] !== 0x01) return null // ClientHello
  offset += 4 // type + 3-byte length
  offset += 2 + 32 // version + random
  const sessionIdLength = buffer[offset]
  offset += 1 + sessionIdLength
  const cipherLength = buffer.readUInt16BE(offset)
  offset += 2 + cipherLength
  const compressionLength = buffer[offset]
  offset += 1 + compressionLength
  if (offset + 2 > buffer.length) return null
  const extensionsLength = buffer.readUInt16BE(offset)
  offset += 2
  const extensionsEnd = Math.min(offset + extensionsLength, buffer.length)
  while (offset + 4 <= extensionsEnd) {
    const type = buffer.readUInt16BE(offset)
    const length = buffer.readUInt16BE(offset + 2)
    const dataStart = offset + 4
    if (type === 0x0000) {
      // server_name extension
      let cursor = dataStart + 2 // server_name_list length
      if (cursor + 3 > buffer.length) return null
      const nameType = buffer[cursor]
      const nameLength = buffer.readUInt16BE(cursor + 1)
      cursor += 3
      if (nameType !== 0) return null
      return buffer.subarray(cursor, cursor + nameLength).toString('ascii')
    }
    offset = dataStart + length
  }
  return null
}
