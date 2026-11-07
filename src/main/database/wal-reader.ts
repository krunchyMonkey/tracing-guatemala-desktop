import { closeSync, openSync, readSync } from 'node:fs'

// A read-only reader for the write-ahead log (#248). Plain file reads only: it never
// opens SQLite, so it can't create a -shm file or change anything. Format:
// https://www.sqlite.org/fileformat2.html#walformat
// Only the first bytes of page 1 (the database header) are kept, so memory stays fixed
// however large the log is.

const WAL_HEADER_BYTES = 32
const FRAME_HEADER_BYTES = 24
const WAL_VERSION = 3007000
const MAGIC_LE = 0x377f0682
const MAGIC_BE = 0x377f0683
export const DB_HEADER_BYTES = 100

export interface WalSummary {
  /** Frames up to and including the last valid commit frame. */
  committedFrames: number
  /** First 100 bytes of page 1 as of the last valid commit, or null if no committed frame holds page 1. */
  page1: Buffer | null
}

function checksum(buf: Buffer, start: number, end: number, bigEndian: boolean, seed: [number, number]): [number, number] {
  let s0 = seed[0]
  let s1 = seed[1]
  for (let i = start; i + 8 <= end; i += 8) {
    const x0 = bigEndian ? buf.readUInt32BE(i) : buf.readUInt32LE(i)
    const x1 = bigEndian ? buf.readUInt32BE(i + 4) : buf.readUInt32LE(i + 4)
    s0 = (s0 + x0 + s1) >>> 0
    s1 = (s1 + x1 + s0) >>> 0
  }
  return [s0, s1]
}

/** Summarizes the valid, committed part of the log, or null if the log header is invalid, unknown or truncated. */
export function readWal(walFile: string): WalSummary | null {
  const fd = openSync(walFile, 'r')
  try {
    const head = Buffer.alloc(WAL_HEADER_BYTES)
    if (readSync(fd, head, 0, WAL_HEADER_BYTES, 0) < WAL_HEADER_BYTES) return null
    const magic = head.readUInt32BE(0)
    if (magic !== MAGIC_LE && magic !== MAGIC_BE) return null
    const bigEndian = magic === MAGIC_BE
    if (head.readUInt32BE(4) !== WAL_VERSION) return null
    const pageSize = head.readUInt32BE(8)
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) return null
    let sum = checksum(head, 0, 24, bigEndian, [0, 0])
    if (sum[0] !== head.readUInt32BE(24) || sum[1] !== head.readUInt32BE(28)) return null
    const salt1 = head.readUInt32BE(16)
    const salt2 = head.readUInt32BE(20)

    const frame = Buffer.alloc(FRAME_HEADER_BYTES + pageSize)
    let frames = 0
    let committedFrames = 0
    let committedPage1: Buffer | null = null
    let pendingPage1: Buffer | null = null
    for (let position = WAL_HEADER_BYTES; ; position += frame.length) {
      if (readSync(fd, frame, 0, frame.length, position) < frame.length) break
      const pageNumber = frame.readUInt32BE(0)
      if (pageNumber === 0) break
      if (frame.readUInt32BE(8) !== salt1 || frame.readUInt32BE(12) !== salt2) break
      sum = checksum(frame, 0, 8, bigEndian, sum)
      sum = checksum(frame, FRAME_HEADER_BYTES, frame.length, bigEndian, sum)
      if (sum[0] !== frame.readUInt32BE(16) || sum[1] !== frame.readUInt32BE(20)) break
      frames += 1
      if (pageNumber === 1) pendingPage1 = Buffer.from(frame.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + DB_HEADER_BYTES))
      if (frame.readUInt32BE(4) !== 0) {
        committedFrames = frames
        committedPage1 = pendingPage1
      }
    }
    return { committedFrames, page1: committedPage1 }
  } finally {
    closeSync(fd)
  }
}
