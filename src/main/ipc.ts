import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { IpcChannel, type AppInfo, type IpcChannelName } from '../shared/ipc'

/** Thrown to the renderer without echoing its input (which may contain personal data). */
export class IpcRejectedError extends Error {
  constructor(reason: 'untrusted-sender' | 'invalid-arguments') {
    super(`IPC request rejected: ${reason}`)
    this.name = 'IpcRejectedError'
  }
}

interface ChannelContract<Args extends z.ZodTuple, Result extends z.ZodType> {
  channel: IpcChannelName
  args: Args
  result: Result
}

export const contracts = {
  getAppInfo: {
    channel: IpcChannel.getAppInfo,
    args: z.tuple([]),
    result: z.strictObject({
      name: z.string().min(1),
      version: z.string().min(1),
      platform: z.string().min(1)
    }) satisfies z.ZodType<AppInfo>
  }
} as const

/**
 * Wrap a handler so every call checks that it came from the trusted renderer
 * origin, validates arguments against the contract, and validates the result.
 */
export function createValidatedHandler<Args extends z.ZodTuple, Result extends z.ZodType>(
  contract: ChannelContract<Args, Result>,
  isTrustedSender: (url: string) => boolean,
  impl: (args: z.output<Args>) => z.input<Result> | Promise<z.input<Result>>
): (event: Pick<IpcMainInvokeEvent, 'senderFrame'>, ...rawArgs: unknown[]) => Promise<z.output<Result>> {
  return async (event, ...rawArgs) => {
    const senderUrl = event.senderFrame?.url ?? ''
    if (!isTrustedSender(senderUrl)) throw new IpcRejectedError('untrusted-sender')

    const parsed = contract.args.safeParse(rawArgs)
    if (!parsed.success) throw new IpcRejectedError('invalid-arguments')

    return contract.result.parse(await impl(parsed.data))
  }
}

export interface IpcDependencies {
  isTrustedSender: (url: string) => boolean
  getAppInfo: () => AppInfo
}

export function registerIpcHandlers(ipcMain: Pick<IpcMain, 'handle'>, deps: IpcDependencies): void {
  const { getAppInfo } = contracts
  ipcMain.handle(getAppInfo.channel, createValidatedHandler(getAppInfo, deps.isTrustedSender, () => deps.getAppInfo()))
}
