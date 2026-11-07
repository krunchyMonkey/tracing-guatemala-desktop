import { join } from 'node:path'

// Names shared by the connection and the non-mutating preflight. Kept in their own
// module so schema-preflight.ts never imports the module that opens databases.

export const DATABASE_FILE_NAME = 'tracing-guatemala.sqlite'

/** SQLite application_id ("TGD1"), so a backup can be told apart from any other SQLite file. */
export const APPLICATION_ID = 0x54474431

/** Path of the data directory inside Electron's per-user data directory. */
export function dataDirectory(userDataDir: string): string {
  return join(userDataDir, 'data')
}
