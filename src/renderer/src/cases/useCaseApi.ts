import { useAppRuntime, type CaseApi } from '../runtime/AppRuntime'

/** The case calls. Case screens are only routed when the runtime has them. */
export function useCaseApi(): CaseApi {
  const { cases } = useAppRuntime()
  if (!cases) throw new Error('Case screens need a runtime with case support')
  return cases
}
