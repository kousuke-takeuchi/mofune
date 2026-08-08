import { handle } from './handler'
import type { Env } from './handler'

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env)
  },
}
