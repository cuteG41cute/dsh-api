/**
 * dsh-api — DeepSeek Harness external agent HTTP API (plugin core).
 *
 * Plain-JavaScript Cordis plugin core with NO Node-specific imports: it runs
 * identically as a dynamic Cordis plugin and as a loader-mounted package. It
 * registers REST routes on the host `webServer`, runs every incoming request
 * on a fresh (or resumed) agent composed from an agent preset, and serves the
 * final reply and transcript until the caller deletes the task.
 *
 * Routes (default prefix /api/v1):
 *   GET    /api/v1/health          -> service health
 *   POST   /api/v1/tasks           -> submit a task ({ prompt, preset?, cwd?,
 *                                      model?, provider?, maxTokens?,
 *                                      system?, timeoutMs?, sessionId?,
 *                                      wait?, waitTimeoutMs? })
 *   GET    /api/v1/tasks           -> list recent tasks
 *   GET    /api/v1/tasks/:taskId   -> poll status / read result
 *   DELETE /api/v1/tasks/:taskId   -> cancel + release the agent
 *
 * Auth: `Authorization: Bearer <key>` or `X-API-Key: <key>`; disabled when
 * config.apiKey is empty.
 */

'use strict'

// ---------------------------------------------------------------------------
// Model-selection install — mirror of @deepseek-ai/dsh-agent's
// installModelSelection so the agent's persona {{model}} variable and request
// routing behave exactly like a Web session.
// ---------------------------------------------------------------------------
function installModelSelectionLocal(agentCtx, selection) {
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = selection.current
    const assembled = await next()
    selection.assembled = selected
    if (selected === undefined) return assembled
    return {
      ...assembled,
      variables: {
        ...assembled.variables,
        provider: selected.provider,
        model: selected.model,
      },
    }
  })
  const disposeRequest = agentCtx.on('agent/request', async (_payload, next) => {
    const resolved = await next()
    const selected = selection.assembled
    if (selected === undefined) return resolved
    const { reasoningEffort: _inherited, ...withoutInherited } = resolved
    return {
      ...withoutInherited,
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    }
  })
  return () => {
    disposeAssembly()
    disposeRequest()
  }
}

// ---------------------------------------------------------------------------
// Small plain-JS helpers (no Node-specific globals).
// ---------------------------------------------------------------------------
function mintId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

function userMessage(text, source) {
  return {
    id: mintId('msg'),
    role: 'user',
    content: [{ type: 'text', text }],
    source: source || { kind: 'user' },
  }
}

function textOf(message) {
  const blocks = message && message.content
  if (!Array.isArray(blocks)) return ''
  return blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('')
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('request body too large'))
        try { req.destroy() } catch { /* ignore */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const buf = new Uint8Array(size)
      let off = 0
      for (const c of chunks) {
        buf.set(c, off)
        off += c.length
      }
      resolve(new TextDecoder('utf-8').decode(buf))
    })
    req.on('error', reject)
  })
}

function pathnameOf(url) {
  const q = url.indexOf('?')
  return q === -1 ? url : url.slice(0, q)
}

function isAbsolutePath(p) {
  if (typeof p !== 'string' || p.length === 0) return false
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')
}

// ---------------------------------------------------------------------------
// Task lifecycle
// ---------------------------------------------------------------------------
function summarize(events, firstSeq) {
  let started = false
  let reply = ''
  const transcript = []
  const toolCalls = []
  let turnEnd
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') { started = true; continue }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = textOf(event.data.message)
      if (joined !== '') {
        reply = joined
        transcript.push({ role: 'assistant', text: joined })
      }
    } else if (event.type === 'user/message' && event.data.source && event.data.source.kind === 'user') {
      const joined = textOf(event.data)
      if (joined !== '') transcript.push({ role: 'user', text: joined })
    } else if (event.type === 'tool/call') {
      toolCalls.push({ name: event.data.name, callId: event.data.callId })
    } else if (event.type === 'turn/end') {
      turnEnd = event.data.reason
    }
  }
  return { reply, transcript, toolCalls, turnEnd }
}

/**
 * Drive one task to quiescence and store the outcome on the task record.
 * Never rejects: every failure lands on the task record.
 */
async function runTask(ctx, state, task) {
  const cfg = state.cfg
  const timer = ctx.get('timer') || { timeout: ctx.timeout }
  const finish = (patch) => {
    Object.assign(task, patch)
    task.finishedAt = Date.now()
    state.running = Math.max(0, state.running - 1)
    if (task._resolve) task._resolve(task)
  }

  state.running += 1
  let handle
  let timedOut = false

  try {
    const agents = ctx.get('agents')
    const sessions = ctx.get('sessions')
    const agentPresets = ctx.get('agentPresets')
    const agentDefaultModel = ctx.get('agentDefaultModel')
    if (!agents) {
      return finish({ status: 'failed', error: { code: 'NO_AGENTS', message: 'agents service unavailable' } })
    }

    // Resolve model selection + preset BEFORE creation (meta is snapshotted
    // before setup runs).
    const selection = agentDefaultModel ? agentDefaultModel.currentSelection() : undefined
    const provider = task.provider || (selection && selection.provider)
    const model = task.model || (selection && selection.model)
    const agentOptions = {}
    if (provider) agentOptions.provider = provider
    if (model) agentOptions.model = model
    if (task.maxTokens) agentOptions.maxTokens = task.maxTokens

    let resolvedPresetId
    if (agentPresets) {
      try {
        resolvedPresetId = (await agentPresets.resolve(task.preset || cfg.defaultPreset)).id
      } catch (error) {
        return finish({
          status: 'failed',
          error: { code: 'PRESET', message: 'cannot resolve agent preset: ' + (error && error.message ? error.message : String(error)) },
        })
      }
    }

    const selRef = { current: selection, assembled: undefined }
    const setup = async (agentCtx) => {
      installModelSelectionLocal(agentCtx, selRef)
      if (agentPresets && resolvedPresetId) await agentPresets.mount(agentCtx, resolvedPresetId)
    }

    // Reuse a live idle agent for continuations; otherwise create or resume.
    const live = task.continuation && state.handles.get(task.sessionId)
    if (live && live.agent.status === 'idle') {
      handle = live
      if (live.cleanup) { try { live.cleanup() } catch { /* ignore */ } live.cleanup = undefined }
    } else if (task.continuation) {
      handle = await agents.resume({ resumeSessionId: task.sessionId, agentOptions, setup })
    } else {
      handle = await agents.create({
        sessionId: task.sessionId,
        meta: {
          ...(task.cwd ? { cwd: task.cwd } : {}),
          ...(resolvedPresetId ? { agentPreset: resolvedPresetId } : {}),
        },
        agentOptions,
        setup,
      })
    }
    const agent = handle.agent
    state.handles.set(task.sessionId, { agent, handle, cleanup: undefined })

    // Timeout guard: cancel the agent when the budget expires.
    const timeoutMs = Math.min(Math.max(Number(task.timeoutMs) || cfg.defaultTimeoutMs, 1000), cfg.maxTimeoutMs)
    let firstSeq = 0
    const timeoutDisposer = timer.timeout(() => {
      if (!timedOut && task.status === 'running' && state.handles.get(task.sessionId) === handle) {
        timedOut = true
        try { agent.cancel({ kind: 'user' }) } catch { /* ignore */ }
      }
    }, timeoutMs)

    try {
      // Creation quiescence, then open the turn.
      await agent.whenIdle()
      firstSeq = agent.session.seq
      if (task.system) {
        agent.inject(userMessage(task.system, { kind: 'plugin', plugin: 'dsh-api', form: 'instructions' }))
      }
      agent.followup(userMessage(task.prompt))
      await agent.whenIdle()
    } finally {
      timeoutDisposer()
    }

    if (sessions) {
      try { await sessions.flush(agent.session) } catch { /* flush is best-effort */ }
    }

    const outcome = summarize(agent.session.events, firstSeq)
    const turnKind = outcome.turnEnd ? outcome.turnEnd.kind : 'unknown'

    let status
    let error
    if (timedOut) status = 'timeout'
    else if (task._cancelRequested) status = 'canceled'
    else if (turnKind === 'error') {
      status = 'failed'
      const e = outcome.turnEnd.error || {}
      error = { code: e.code || 'LLM_ERROR', message: e.message || 'model request failed' }
    } else if (turnKind === 'aborted') {
      status = 'failed'
      error = { code: 'ABORTED', message: 'task turn was aborted' }
    } else {
      status = 'completed'
    }

    let providerUsed
    let modelUsed
    try {
      const header = agent.session.requestHeader && agent.session.requestHeader()
      if (header && header.config) {
        providerUsed = header.config.provider
        modelUsed = header.config.model
      }
    } catch { /* ignore */ }

    const patch = {
      status,
      reply: outcome.reply,
      transcript: outcome.transcript,
      toolCalls: outcome.toolCalls,
      turnEnd: turnKind,
      error,
      provider: providerUsed || provider,
      model: modelUsed || model,
    }

    // Retention: release the live agent after a grace window so the session
    // stays inspectable in the Web UI; continuations cancel this timer.
    if (state.handles.get(task.sessionId) === handle) {
      const entry = state.handles.get(task.sessionId)
      entry.cleanup = timer.timeout(() => {
        if (state.handles.get(task.sessionId) !== handle) return
        state.handles.delete(task.sessionId)
        handle.dispose().catch(() => { /* agent already gone */ })
      }, cfg.retentionMs)
    }

    finish(patch)
  } catch (error) {
    finish({
      status: 'failed',
      error: { code: 'INTERNAL', message: error && error.message ? error.message : String(error) },
    })
  }
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------
function sendJson(res, status, body) {
  if (res.writableEnded) return
  const payload = JSON.stringify(body)
  const bytes = new TextEncoder().encode(payload).length
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(bytes),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    'Access-Control-Max-Age': '86400',
  }
  try {
    res.writeHead(status, headers)
    res.end(payload)
  } catch { /* client went away */ }
}

function apiError(code, message) {
  return { ok: false, error: { code, message } }
}

function authorized(req, apiKey) {
  if (!apiKey) return true
  const auth = req.headers['authorization'] || ''
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const key = req.headers['x-api-key']
  if (bearer !== '' && bearer === apiKey) return true
  if (typeof key === 'string' && key !== '' && key === apiKey) return true
  return false
}

function taskSummary(task) {
  return {
    taskId: task.taskId,
    sessionId: task.sessionId,
    status: task.status,
    continuation: task.continuation === true,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    preset: task.preset,
    provider: task.provider,
    model: task.model,
    prompt: task.prompt,
    reply: task.reply || '',
    transcript: task.transcript || [],
    toolCalls: task.toolCalls || [],
    turnEnd: task.turnEnd,
    error: task.error,
  }
}

/**
 * Register the API routes and return the task store state.
 */
function mountApi(ctx, cfg) {
  const state = {
    cfg,
    tasks: new Map(),      // taskId -> task
    bySession: new Map(),  // sessionId -> last taskId
    handles: new Map(),    // sessionId -> { agent, handle, cleanup }
    running: 0,
  }
  const webServer = ctx.get('webServer')
  if (!webServer) {
    console.error('dsh-api: webServer service unavailable; routes not registered')
    return state
  }

  const prefix = cfg.prefix
  const tasksPath = prefix + '/tasks'

  const handleCreate = async (req, res) => {
    let bodyText
    try {
      bodyText = await readBody(req, cfg.maxBodyBytes)
    } catch (error) {
      return sendJson(res, 413, apiError('payload_too_large', error && error.message ? error.message : 'request body too large'))
    }
    let body
    try {
      body = JSON.parse(bodyText || '{}')
    } catch {
      return sendJson(res, 400, apiError('invalid_json', 'request body must be valid JSON'))
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return sendJson(res, 400, apiError('invalid_body', 'request body must be a JSON object'))
    }

    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt) return sendJson(res, 400, apiError('missing_prompt', 'field "prompt" (string) is required'))
    if (prompt.length > cfg.maxPromptChars) {
      return sendJson(res, 413, apiError('prompt_too_long', 'prompt exceeds ' + cfg.maxPromptChars + ' characters'))
    }

    // Continuation: the session must be known to this API.
    let sessionId
    let continuation = false
    if (typeof body.sessionId === 'string' && body.sessionId !== '') {
      sessionId = body.sessionId
      const knownTask = state.bySession.has(sessionId) ? state.tasks.get(state.bySession.get(sessionId)) : undefined
      if (!knownTask) {
        return sendJson(res, 404, apiError('unknown_session', 'session ' + sessionId + ' was not created through this API'))
      }
      if (typeof body.preset === 'string' && knownTask.preset && body.preset !== knownTask.preset) {
        return sendJson(res, 409, apiError('preset_conflict', 'session runs preset "' + knownTask.preset + '"; cannot switch to "' + body.preset + '"'))
      }
      continuation = true
    } else {
      sessionId = mintId('api')
    }

    // Validate preset id up front so a typo fails at submit time.
    const agentPresets = ctx.get('agentPresets')
    let preset = typeof body.preset === 'string' && body.preset !== '' ? body.preset : cfg.defaultPreset
    if (agentPresets && preset) {
      try {
        preset = (await agentPresets.resolve(preset)).id
      } catch {
        return sendJson(res, 400, apiError('bad_preset', 'unknown agent preset: ' + preset))
      }
    }

    if (body.cwd !== undefined && !isAbsolutePath(body.cwd)) {
      return sendJson(res, 400, apiError('bad_cwd', 'field "cwd" must be an absolute path'))
    }
    if (state.running >= cfg.maxConcurrent) {
      return sendJson(res, 429, apiError('busy', 'too many concurrent tasks (max ' + cfg.maxConcurrent + ')'))
    }

    const task = {
      taskId: mintId('task'),
      sessionId,
      continuation,
      prompt,
      system: typeof body.system === 'string' && body.system !== '' ? body.system : undefined,
      preset,
      cwd: typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : cfg.defaultCwd,
      provider: typeof body.provider === 'string' && body.provider !== '' ? body.provider : undefined,
      model: typeof body.model === 'string' && body.model !== '' ? body.model : undefined,
      maxTokens: Number.isFinite(body.maxTokens) ? body.maxTokens : undefined,
      timeoutMs: Number.isFinite(body.timeoutMs) ? body.timeoutMs : undefined,
      status: 'running',
      createdAt: Date.now(),
      startedAt: undefined,
      finishedAt: undefined,
      reply: '',
      transcript: [],
      toolCalls: [],
      turnEnd: undefined,
      error: undefined,
      _resolve: undefined,
      _cancelRequested: false,
    }
    state.tasks.set(task.taskId, task)
    state.bySession.set(task.sessionId, task.taskId)
    task._completion = new Promise((resolve) => { task._resolve = resolve })
    runTask(ctx, state, task)

    if (body.wait === true) {
      const waitMs = Math.min(
        Math.max(Number.isFinite(body.waitTimeoutMs) ? body.waitTimeoutMs : (Number.isFinite(task.timeoutMs) ? task.timeoutMs : cfg.defaultTimeoutMs) + 30000, 1000),
        cfg.maxTimeoutMs + 60000,
      )
      const timer = ctx.get('timer') || { timeout: ctx.timeout }
      let timerFired = false
      let resolveTimer
      const timerPromise = new Promise((resolve) => { resolveTimer = resolve })
      const timerDisposer = timer.timeout(() => { timerFired = true; resolveTimer() }, waitMs)
      await Promise.race([task._completion, timerPromise])
      timerDisposer()
      if (timerFired) {
        return sendJson(res, 202, { ok: true, data: { taskId: task.taskId, sessionId: task.sessionId, status: task.status } })
      }
      return sendJson(res, 200, { ok: true, data: taskSummary(task) })
    }

    return sendJson(res, 202, {
      ok: true,
      data: { taskId: task.taskId, sessionId: task.sessionId, status: 'running' },
    })
  }

  const handleTasks = async (req, res) => {
    if (!authorized(req, cfg.apiKey)) {
      return sendJson(res, 401, apiError('unauthorized', 'missing or invalid API key (Authorization: Bearer <key> or X-API-Key: <key>)'))
    }
    if (req.method === 'OPTIONS') return sendJson(res, 204, null)
    const pathname = pathnameOf(req.url)

    if (pathname === tasksPath) {
      if (req.method === 'GET') {
        const list = []
        for (const task of state.tasks.values()) {
          list.push(taskSummary(task))
          if (list.length >= 50) break
        }
        return sendJson(res, 200, { ok: true, data: { tasks: list } })
      }
      if (req.method === 'POST') return handleCreate(req, res)
      return sendJson(res, 405, apiError('method_not_allowed', 'allowed: GET, POST'))
    }

    if (pathname.startsWith(tasksPath + '/')) {
      const taskId = pathname.slice(tasksPath.length + 1)
      if (!taskId || taskId.indexOf('/') !== -1) return sendJson(res, 404, apiError('not_found', 'unknown task id'))
      const task = state.tasks.get(taskId)
      if (!task) return sendJson(res, 404, apiError('not_found', 'unknown task id ' + taskId))
      if (req.method === 'GET') return sendJson(res, 200, { ok: true, data: taskSummary(task) })
      if (req.method === 'DELETE') {
        task._cancelRequested = true
        const live = state.handles.get(task.sessionId)
        if (live) {
          try { live.agent.cancel({ kind: 'user' }) } catch { /* ignore */ }
        }
        return sendJson(res, 200, { ok: true, data: { taskId, status: 'cancel-requested' } })
      }
      return sendJson(res, 405, apiError('method_not_allowed', 'allowed: GET, DELETE'))
    }

    return sendJson(res, 404, apiError('not_found', 'no such route'))
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: prefix + '/health',
    handler: (req, res) => {
      if (!authorized(req, cfg.apiKey)) return sendJson(res, 401, apiError('unauthorized', 'missing or invalid API key'))
      if (req.method === 'OPTIONS') return sendJson(res, 204, null)
      if (req.method !== 'GET') return sendJson(res, 405, apiError('method_not_allowed', 'allowed: GET'))
      sendJson(res, 200, { ok: true, data: { service: 'dsh-api', version: '1.0.0', time: Date.now() } })
    },
  }))

  ctx.effect(() => webServer.register({ kind: 'prefix', path: tasksPath, handler: handleTasks }))

  console.log('dsh-api: routes mounted at http://127.0.0.1:' + (webServer.port || 3080) + prefix +
    ' (auth: ' + (cfg.apiKey ? 'api-key required' : 'DISABLED') + ')')
  return state
}

export { mountApi, summarize, userMessage, installModelSelectionLocal }
